# 效能靜態分析：Tier 1 程式碼架構與實作細節

日期 2026-10-09。對象：`feature/tier-1` @ `4e6907e`，對照 Tier 0 `2d7ee6e`。方法：只讀程式碼（含 three.js 0.186.1 與 wasm-bindgen 產生的 glue），不量測；每個發現都標 `檔案:行`，並和 `docs/perf-tier1-vs-tier0.md` 的量測數字互相印證。所有建議都只列不改。

## 0. 結論

量測看到的三件事，程式碼都解釋得通：

| 量測現象 | 程式碼原因 | 章節 |
|---|---|---|
| 同場景 Tier 1 只多 +0.05 到 +0.10 ms/幀 | 幀迴圈新增的東西都是 O(1) 或 O(selected)：`selection.update()` 沒選取時是空迴圈、`TimeState` 多一個 signal 讀取、每幀兩次 `clientWidth/Height`、三個 `measure()` 閉包 | §1 |
| Camera display 每幀 2.6 到 3.6 ms | `CameraDisplay.render()` 每幀 traverse 全場景改 layer bit，再用第二個 renderer 把整個場景畫一次；面板隱藏時這些照跑 | §1.1 |
| tier1_scene render 1.3 → 4.2 ms、draw call 79 → 236 | Odometry 每個 pose 7 個 Object3D、5 個 mesh、5 個獨立 material，全部走 transparent 排序；TF 每個 frame 9 個 Object3D、6 個 drawable | §1.2 |
| 拾取 10×10 要 12 到 24 ms | 不是讀像素，是「再畫一次整個場景」+ 同步 `gl.readPixels` 把 GPU 佇列排空；frustumCulled=false 的點雲/instanced pool 在 1×1 的拾取裡也全畫 | §4.1 |

程式碼層面還找到量測看不到、但值得處理的三類問題：

1. **資料路徑拷貝過多**：一個 300k 點雲從 socket 到 GPU 被完整複製約 5 次（25 MB/訊息、10 Hz ≈ 250 MB/s），而且 wasm 回傳的結構從不 `.free()`，靠 GC 的 FinalizationRegistry 回收，wasm 線性記憶體只增不減（§2.1）。
2. **沒有 latest-only 背壓**：worker 每個 frame 都解碼、主執行緒每個訊息都套用，兩個點雲在同一個 rAF 間隔到達會做兩次 `.set()` 只畫一次；主執行緒慢於訊息率時 MessagePort 佇列無上限（§2.2）。
3. **三個洩漏/成長點**：worker 的 `recent` 速率視窗只在 Debug panel 開著時修剪（Tier 0 也有）；MarkerArray 每個轉換失敗的 marker 都建一列 status 且永不刪除；`crates/wasm/target/` 93 MB 曾被誤 commit（已在 `4e6907e` 移出索引）（§2.5、§6）。

## 1. 每幀路徑（主執行緒）

`Viewport.frame()`（`web/src/render/Renderer.ts:110-135`）→ `VisualizationManager.update()`（`web/src/displays/manager.ts:162-170`：fixed-frame 狀態比對 → `views.update` → `root.update` → `selection.update`）→ `renderer.render` → `extraViews` 的 `CameraDisplay.render()`。

有 `update()` 的 display：grid、axes、map、tf、三種點雲（PointCloudCommon）、marker/markerArray（MarkerScene）、robotModel、image、camera。沒有 `update()` 的（成本只在 three.js 的 matrix 更新與 render list）：path、pose、poseArray、odometry、poseWithCovariance、pointStamped、polygon、gridCells、range。

### Tier 1 對幀迴圈的增量

| 位置 | Tier 0 | Tier 1 | 複雜度 |
|---|---|---|---|
| `Renderer.ts:127-128` | `views.setAspect(w/h)` | 每幀讀 `clientWidth/clientHeight` + `resize()` + `setViewportSize` | O(1)，但 DOM 剛被改過時是一次強制 layout |
| `Renderer.ts:131` | – | `for (v of extraViews) measure('camera view', () => v.render())` | O(extraViews) 閉包 + Set iterator；每個 view 是 O(場景物件) |
| `manager.ts:163` | `bridge.clock()` | `TimeState.rosTimeNs` = `paused()` + `clock()` | O(1) |
| `manager.ts:169` | – | `selection.update()` | O(selected)，每項有閉包 |
| tf / marker / pointcloud / views 的 update | 相同 | 相同（TF 只多了 pickable 登錄與 selection hook，皆非每幀） | – |
| 新 display `robotModel.update` | – | 每幀每 link/joint 4 個物件配置 + 最多 9 次 signal 寫入 | O(links + joints) |
| 新 display `camera.update/render` | – | `syncVisibility` O(D²) + 全場景 traverse + 第二個 renderer | O(場景物件) |
| 新 display `image.update` | – | `if (!panelOpen) ensurePanel()` | O(1) |
| odometry / poseWithCovariance / pointStamped / polygon / gridCells / range | – | 無 update；Odometry 每 pose 7 個 Object3D | O(物件) 在 render 內 |

### 1.1 CameraDisplay：每幀 O(場景物件) 的 layer traverse、O(D²) 的 visibility 同步、第二次完整 render（面板隱藏也照跑）

- `web/src/displays/cameraDisplay.ts:160-163` `update()` 每幀呼叫 `syncVisibility()`：`:144` 讀 `rootDisplays()` signal；`:145` `[...this.visProps]` 每幀把 Map 展開成新陣列；`:146` 迴圈內 `displays.includes(d)` → O(D²)。display 清單是 signal，整段可以改成事件驅動。
- `:166-229` `render()`：`:172` tf lookup、`:176` 每幀 `setStatus`、`:181/:204` `panel.imageSize()` 每次回傳新物件、`:189` 每幀一個陣列字面值；**`:222-224` 對每個 root display 的 `sceneNode.traverse()` 改 `layers`**，每個 display 一個閉包、走過所有 Object3D（TF 每 frame 9 個、Odometry 每 pose 7 個、robot link、點雲、marker pool…），純粹的 churn。
- `web/src/panels/CameraPanel.ts:475` `if (!r || !this.ready || !this.visible) return;` 這個「面板不可見就跳過」在 `panel.render()` 裡面，前面的 tf lookup、投影計算、全場景 traverse 都已經做完。`:476-477` 每幀讀 `clientWidth/Height`；`:489-499` 在第二個 `WebGPURenderer`（`:430`）上 render 2 到 3 次，整個場景的 material 在這個 renderer 再編譯一份 pipeline。
- 建議：layer bit 只在 Visibility 勾選或 display 增減時改；把 `visible` 檢查提到 `render()` 開頭；收到新影像、TF 或相機 pose 變動才重畫，或限制 ≤15 Hz；`imageSize()` 回傳快取的兩個數字。

### 1.2 Odometry / PoseWithCovariance：每個 pose 一組獨立 mesh 與 material

- `web/src/render/covarianceVisual.ts:29-50`：一個 `CovarianceVisual` = 1 Group + 1 橢球 Mesh + 1 orientation Group + 3 圓盤 Mesh + 1 扇形 Mesh = **7 個 Object3D、5 個 Mesh、5 個各自的 `MeshBasicMaterial`（transparent、depthWrite=false）**、1 個獨立 geometry（扇形）。
- `web/src/displays/odometryDisplay.ts:129-140`：每個保留的 pose 一個 visual（Keep 預設 100）→ 700 個 Object3D、500 個 material；箭頭與座標軸已是 `InstancedMesh`（`:61-62`）。每幀 three.js 對 700 個節點 `updateMatrixWorld`（`matrixAutoUpdate` 預設 true 會重組 position/quaternion/scale），透明物件再排序。dev 探針量到 Odometry 185 個可繪物件、顯示中 77 個與此一致。
- `web/src/displays/poseWithCovarianceDisplay.ts:43-45`：Arrow(3) + Axes(4) + CovarianceVisual(7) = 14 個 Object3D。
- 建議：橢球一組、三個圓盤各一組、扇形一組 `InstancedMesh`，顏色用 per-instance attribute；至少同 (style, color) 共用一個 material；隱藏的 visual 設 `matrixAutoUpdate=false`。這是 D/E 情境 render 4.2 ms 的主因。

### 1.3 RobotModelDisplay.update()：每幀每 link/joint 配置物件並寫 Solid signal

- `web/src/displays/robotModelDisplay.ts:556-596`，`Update Interval` 預設 0 → 每幀：`:566` 有 TF prefix 時每 link 建一個字串；`:571-572` `position.setValue({x,y,z})`、`orientation.setValue({x,y,z,w})` 每 link 2 個物件字面值，`Property.ts:337-338 / 391-392` 的 `normalize()` 再複製 2 份 → 每 link 每幀 4 次配置；link 移動時 `setValue` 寫 signal，Vector/Quaternion 的 onChange 再寫 3 + 4 個子 signal → 每 link 最多 9 次 signal 寫入，Solid 同步執行相依 effect（幀內沒有 `batch()`），Links 群組展開時每幀更新 DOM 文字。`:580-593` joint 同樣。`:594-595` 每幀組 status 字串。
- TF display 有 5 Hz 的細節更新節流（`tfDisplay.ts:27` `DETAIL_UPDATE_S = 0.2`），RobotModel 沒有。
- 建議：pose 屬性列改 5 Hz 更新或只在列可見時更新；寫入前比較數值；`manager.update()` 外包 `batch()`。

### 1.4 TfDisplay.update()：每 TF frame 9 個 Object3D；`syncFrameList` 每幀配置

- 每個 frame（`tfDisplay.ts:30-46` + `primitives.ts:30-43, 66-80, 121-129`）：node Group + Axes Group + 3 圓柱 Mesh + Arrow Group + 2 Mesh + 1 TextSprite = **9 個 Object3D、6 個 drawable、5 個 material**。11 個 frame = 66 個 drawable，和量到的數字一致。Label 預設 `visible=false` 但仍每幀更新 matrix。
- `:197` `syncFrameList()` 每幀（Update Interval 預設 0）：`:136` `new Set`、`:153` `for (const [name, info] of this.frames)` 每個 frame 配置一個 `[k,v]`；`:162` 讀 `tf.framesVersion()`，但整個 sync 其實只需要在這個 version 變動時跑。
- `:206-241` 每個可見 frame 每幀：`frameAllowed()`（`:121-131`：**有設 filter 時每幀每 frame `new RegExp`**）、2 次 tf lookup、`setOpacity`（`:60-64` 即使 alpha 沒變也寫 5 個 material 的 `opacity/transparent`）；`:232-240` 5 Hz 的 4 到 5 次 `setValue({...})`；`:242-244` 每幀 status 字串。
- Tier 0 與 Tier 1 的每幀程式碼相同；Tier 1 裡 TF 佔比變大是因為它的 66 個 drawable 多了兩個消費者（Camera traverse + 第二次 render、拾取 pass）。
- 建議：`framesVersion` 變動才 `syncFrameList`；用 `frames.values()`；RegExp 在 filter 變動時編譯一次；alpha 變了才 `setOpacity`。

### 1.5 SelectionManager.update()：O(selected)，每項有閉包，最多 2000 個高亮框

- `web/src/app/selection.ts:97-102` 每幀對每個選取項呼叫 `updateSelection` / `selectionBounds`。owner 端：`tfDisplay.ts:289-297` 5 次 `prop.child(name)`（`Property.ts:108-110` 是 `children().find(閉包)`）+ 5 個物件字面值；`robotModelDisplay.ts:607-619` `Box3.setFromObject(e.node)` 走整個 link 子樹；`pointCloudCommon.ts:232-233` `clouds.find(閉包)`；`markerDisplay.ts:121-128` `entryForHit` **線性掃 `entries`** → O(selected × markers) 每幀。
- `selection.ts:59-67` 每個選取項一個 `Box3Helper`（各自的 geometry + `LineBasicMaterial`，`depthTest=false`，renderOrder 999），上限 `MAX_HIGHLIGHTS = 2000` → 主視圖與每個 Camera 面板各多 2000 個 draw call，且下一次拾取要為每個新 material 編一個 pick pipeline。
- 建議：選取資訊列 5 Hz 更新或只在 Selection panel 可見時更新；`Selected` 項快取已解析的子屬性；高亮框合併成一個 `LineSegments`；marker 用 `Map<Entry, key>` 反查。

### 1.6 其他每幀小項

- **Status 字串**：`grid.ts:88,93,96`、`axes.ts:46,52`、`mapDisplay.ts:231,239`、`tfDisplay.ts:242-244`、`robotModelDisplay.ts:594-595`、`cameraDisplay.ts:173,176`、`manager.ts:174` 每幀組 template literal 再呼叫 `setStatus` → `Property.ts:553-562` `child(name)` 閉包 + `updateLevel()` 再組一個字串。值沒變時 Solid `===` 去重，不碰 DOM，但每 display 每幀 1 個閉包 + 2 到 3 個字串。建議 `setStatus` 開頭先比較 (level, text)，呼叫端只在轉換時呼叫。
- **`Renderer.ts:129-131`** `measure('update'|'render'|'camera view', () => …)` 不論 `?perf` 都先建閉包；`for (const v of manager.extraViews)` 每幀一個 Set iterator。`:133-134` `longFrames()/worstFrameMs()` 每幀讀 signal，寫入只在長幀發生（剛好是已經慢的那幀再多一次 DOM 更新，且只在 `?perf` 下掛載）。
- **`manager.ts:164`** `Number(ros - this.lastRosNs)` 每幀一個 BigInt；`:174` key 字串（Tier 0 相同）。
- **`markerDisplay.ts:359-393`** `MarkerScene.update()`（與 Tier 0 相同）：任一 `frame_locked` marker 會每幀 `dirty` → 全部 pool 重建 + instance attribute 整段重傳（`instancedShapes.ts:300-308`）；有 lifetime 的 marker 時 `:361` 每幀每 entry 配置 `[k,v]`。
- **`topDownOrtho.ts:153`** 每幀 `updateProjectionMatrix()`（orbit / fps 沒有）。
- **幀內沒有 `batch()`**：每個有變化的 `setValue` 都同步觸發訂閱者，一次寫入一次 DOM flush，而不是一幀一次。

### 規格 §9.7「每幀不得配置」的違反清單

`Renderer.ts:129-131`（閉包、Set iterator）、`manager.ts:164`（BigInt）、`:174`（字串）、`tfDisplay.ts:136, :153`（Set、Map entry 陣列）、`:125-126`（設 filter 時每幀 RegExp）、`:234-238`（5 Hz 物件字面值）、`:243-244`（字串）、`robotModelDisplay.ts:566, :571-572, :589-590, :594-595`、`cameraDisplay.ts:145, :181, :189, :204, :224, :173, :176`、`selection.ts:97-102` 經 `tfDisplay.ts:292-296`、`robotModelDisplay.ts:610-611`、`pointCloudCommon.ts:232`、`pathDisplay.ts:206`、`Property.ts:108-110, :553-562`（grid/axes/map/tf/robotModel/camera 的 status 路徑）、`markerDisplay.ts:361`（有 lifetime 時）、`pointCloudCommon.ts:202`（有 decay 時）。

## 2. 訊息路徑（socket → GPU）

流程：`worker.ts:261-301` 收到每個 WebSocket frame 的 ArrayBuffer → `decoders.ts` 把 payload 複製進 wasm（`passArray8ToWasm0`）→ wasm 解碼、建 Vec → 每個 `getter_with_clone` 欄位在 wasm 內 clone 一次、JS 端再 `.slice()` 一次 → typed array 以 transferable 送主執行緒（零拷貝）→ 主執行緒 `.set()` 進 three.js attribute 再上傳 GPU。mock 速率依程式碼修正：`/points` 547×547 = 299,209 點 × 20 B = **5.98 MB** @10 Hz（`mock.rs:974-975`）；mock 相機影像是 **160×120**（`mock.rs:73-74`）@5 Hz，不是 640×480；server 送給前端的 clock 控制訊息是 **10 Hz**（`session.rs:21`），mock 的 `/clock` topic 50 Hz 不進前端。

### 2.1 PointCloud2：每訊息約 25 MB memcpy、~21 MB wasm 配置、回傳結構不釋放（Tier 0 相同）

每個 /points 訊息（10 Hz）：

| 步驟 | 位置 | 拷貝 / 配置 |
|---|---|---|
| WT 多段 stream 重組（只在走 WT 的 topic） | `worker.ts:185-190` | +6 MB 拷貝（WS 路徑的 `ev.data` 已是自有 buffer，無此拷貝） |
| JS → wasm | glue `webrvizlite.js:1881-1883, 2405-2410` | 6 MB 拷貝 |
| `points_from_cloud2` | `crates/core/src/pointcloud.rs:147-195` | xyz 3.6 MB + intensity 1.2 MB + rgb 1.2 MB；每點每欄位 `read_f32`（`msgs/pointcloud.rs:94-123` 每次重新 match datatype、bounds check、endianness 分支）≈ 150 萬次泛型讀取，無法向量化 |
| `build_cloud` | `pointcloud.rs:314-416` | positions 3.6 MB + colors 0.9 MB；每點 f64 `tf.apply_point`（含 f32↔f64 轉換），**transform 是 identity 時也做**；intensity 走每點 `rainbow()` |
| getter clone + `.slice()` | `lib.rs:749` `getter_with_clone`；glue `:1000-1005, :954-957` | positions 3.6 MB ×2 + colors 0.9 MB ×2 = 9 MB |
| 主執行緒 `.set()` | `pointCloud.ts:53-54` | 4.5 MB 進 attribute 陣列（capacity ×2 成長，300k 點的後備陣列是 6.3 + 1.5 MB），update range 限制 GPU 上傳量 |

- **`decoders.ts` 裡沒有任何 `.free()`**（`cloudResult` `:205-219`、`markersResult` `:251-254`、image `:171-176`、`poseCovResult` `:120-130`）。Rust 端的結構（點雲 4.5 MB + 字串）留在 wasm 線性記憶體直到 GC 跑 FinalizationRegistry（glue `:2283+`）；wasm 記憶體只增不減，高水位 = GC 延遲 × 10 Hz × ~21 MB。這是「wasm 記憶體成長」最可能的來源。
- `decoders.ts:221` 每訊息 `JSON.stringify(sub.options.color)` + `lib.rs:812` serde 解析（小）。
- `pointcloud.rs`、`msgs/pointcloud.rs`、`cdr.rs`、`tf.rs`、`marker.rs` 與 Tier 0 **逐 byte 相同**，以上不是退化。
- 建議：wasm 回傳 view（`Float32Array::view`）只複製一次，或讓 wasm 寫進 JS 提供的可重用 buffer；decoder 讀完 getter 就 `.free()`；FLOAT32/LE 全部欄位時走快速路徑（預算 offset、`chunks_exact(point_step)` + `f32::from_le_bytes`）；identity transform 直接 memcpy；rainbow 用 256 格 LUT。

### 2.2 沒有 latest-only / 背壓

- `worker.ts:291-296` 每個 frame 無條件解碼並 post；`client.ts:80-81` 在 `onmessage` 內同步派送。10 Hz 的點雲不管幀率是多少都付全額 §2.1 成本；主執行緒慢於訊息率時 MessagePort 佇列（每個點雲 4.5 MB）無上限成長，WebSocket 再排在後面。兩個點雲落在同一個 rAF 間隔時做兩次 `.set()` 只畫最後一次。
- 建議：主執行緒每個 subscription 一個 `pending` 槽，在 `update()` 裡（render 前）套用最新一筆；worker 端用 in-flight 計數（主執行緒套用後 ack），前一筆未消費就跳過解碼。

### 2.3 每訊息 `material.needsUpdate`

`pointCloud.ts:86-90` 經 `pointCloudCommon.ts:178` `setStyle` 每訊息設 `needsUpdate` → three `Material.version` +1 → `RenderObjects.js:136-146` 下一幀重算整個 node-graph cache key（10 次/秒/點雲）。key 相同時不重建 pipeline，但可避免。建議只在 style/alpha 真的變時設。

### 2.4 WebGPU backend 專屬：Uint8×3 顏色 attribute 每次上傳重新打包

`pointCloud.ts:37` 的顏色 attribute 是 `Uint8Array(capacity*3)`，stride 3 不是 4 的倍數；three 的 `WebGPUAttributeUtils.js:117-123, 200-210` 會 `paddedItemSize=4`，每次 `updateAttribute` 配置 `count*4` 的新陣列並對 `count`（= capacity 524,288，不是點數）跑 `subarray` 迴圈，而且在 update-range 分支之前。本機是 WebGL2 backend（`WebGLAttributeUtils` 不 pad），所以量測沒碰到；在真正的 WebGPU 上會是每訊息 2 MB 配置 + 52 萬次 `subarray`。建議顏色改 Uint8×4（RGBA）或 packed Uint32 在 TSL 解包。POINTS marker 的 `CloudBuffer`（`markerDisplay.ts:240-251`）同樣。

### 2.5 MarkerArray（5,016 @1 Hz）：字串 JSON 來回、status 列 O(n²) 且不刪除

- `lib.rs:952-1018` `pack_markers`：`numeric` 5,016×24×8 B = 963 KB（getter clone + slice 各一次）；`strings_json` 每 marker 5 個字串在 wasm 序列化 → `decoders.ts:252` `JSON.parse` 產生 5,016 個陣列 + 25,080 個 JS 字串 → `worker.ts:294` 用 structured clone 送主執行緒（字串不可 transfer）。`pack_markers` 內每個 marker `transform_for` → `lookup_with_fallback`（`tf.rs:254-265` 每次 2 個 Vec 配置）→ 每訊息 1 到 2 萬次配置，雖然 5,000 個 cube 都是同一個 frame 與 stamp；`marker.rs:55-119` 每 marker 2 到 4 個 String。
- 主執行緒 `markerDisplay.ts:147-218`：每 marker template 字串 key、Map 查找、`quat.normalize()`；`:187` `e.msg = msg` 會把上一筆訊息的陣列釘住直到該 marker 被 DELETE。
- **Status 列**：`:166/:171` 每個無效或無法轉換的 marker 呼叫 `setStatus('error', key, …)` → `Property.ts:523-532` 的 `child(name)` 線性 find + `updateLevel()` 走所有子節點 → `/tf` 還沒到時第一筆 5,016 個 marker ≈ 2,500 萬次迭代，建立 5,016 個 `StatusPropertyImpl`（各 5 個 signal），之後轉換成功也不會刪除（`:95` 的 deleteStatus hook 從未被 `MarkerScene` 呼叫）。
- 建議：字串去重成 string table + u32 索引（transferable）；`pack_markers` 以 (frame_id, stamp) 記憶 transform；錯誤彙整成一列（rviz 風格 "N markers failed"），成功時刪列；讀完 `.free()`。

### 2.6 Odometry（20 Hz）：每筆接受的訊息 `redraw()` 兩次

`odometryDisplay.ts:101-102` `trim()` 內呼叫 `redraw()`（`:108`），`processMessage` 接著再 `redraw()` 一次；每次 `redraw()`（`:111-141`）重算全部 Keep 個 pose 的 5 個 instance matrix、標記 5 個 `instanceMatrix` buffer `needsUpdate`（InstancedMesh 整段 capacity×64 B 上傳，無 update range）、重跑所有 `CovarianceVisual.set` 的三角函數；`:107` `history.shift()` O(n)；Keep=0 時上限 100,000（`:28`）→ 每訊息 O(n)、整體二次方。`:87` `[...d.positions, ...d.orientations].every(...)` 每訊息兩次 spread。dev 探針量到 Odometry processMessage 0.13 到 0.19 ms/次，20 Hz 下約 3 到 4 ms/s，不急但是最容易修的一項。建議去掉重複的 `redraw()`、只 append 最新 pose（`setMatrixAt(n-1)`）、用環形緩衝。

### 2.7 影像、TF snapshot、clock

- 影像：`lib.rs:514` 每次 `Vec::new()` 新配 W×H×4（mock 76.8 KB，640×480 則 1.2 MB）；getter clone + slice；`ImageData` 不 `.free()`；`worker.ts:363-364` unsubscribe 不釋放 `ImageConverter`。主執行緒 `ImagePanel.ts:44-45` 包裝 transferred buffer 後 `putImageData` 一次拷貝，canvas 只在尺寸變時重設，沒問題。建議 converter 內保留 rgba Vec 回傳 view、unsubscribe 時釋放。
- TF snapshot（`worker.ts:335-349`，30 Hz timer）：每 tick `new Float64Array(count*9)`（transfer 所以必須新配）、`snapshot()`（`lib.rs:200-225`）每個 frame 一次 `lookup`（`tf.rs:197-247` 兩次 BTreeMap 字串查找 + 兩個 Vec 配置）+ `is_static`/`last_update_ns` 再兩次查找；**沒有 /tf 訊息時照樣每 tick 跑**。建議 dirty flag、用 index 不用名字。
- clock：`client.ts:69-71` 每 tick 新物件寫 signal（10 Hz）→ `manager.ts:41-48` effect、`TimePanel.tsx` 四個 input、`App.tsx:165` 的 `toFixed(1)`。10 Hz 的 DOM 文字更新，可忽略。

### 2.8 Tier 0 → Tier 1 在共用路徑的差異

- `worker.ts:289`（新）：`selectable` 的點雲 subscription 保留整個 6 MB socket buffer 到下一筆（`Selectable` 預設 true）→ 每個點雲 display 常駐 +6 MB，無 CPU 成本；`describe_point`（`worker.ts:392-403` → `lib.rs:84-129`）為了回答一個點重新解碼整個 300k 點雲（只在點擊時）。
- `worker.ts:139-192`（新 WT 接收）：datagram `slice` 與單段 stream 各多一次拷貝，多段 stream 串接一次；只影響走 WT 的 best-effort topic，/points 預設 reliable 走 WS。
- `markerDisplay.ts:212/204/340`（新）：每個非 pool 的 marker `makePickable/releasePickable` → `PickRegistry`（`picking.ts:48-64`）Map set/delete + freelist，O(1)，id 會重用。第二輪量測 MarkerArray 處理時間兩版相同（2.46 vs 2.49 ms）與此一致。
- `pointCloud.ts`、`pointCloudCommon.addCloud`、wasm 點雲路徑與 Tier 0 相同。

### 2.9 洩漏 / 無上限成長

- **`worker.ts:277`** 每個 binary frame `s.recent.push([now, bytes])`，只在 `snapshotStats`（`:320`，Debug panel 掛載時才 `enableStats(true)`）修剪。mock 下約 70 到 100 frame/s → 每秒 ~100 個小陣列永久保留（約 15 MB/小時）。**Tier 0 相同。** 建議在 `onFrame` 內修剪或改計數器。
- wasm 回傳結構不釋放（§2.1）。
- MarkerArray 錯誤 status 列不刪除（§2.5）。
- `TfBuffer.frames/index`（`tf.rs:95-109`）只隨不同 frame 名稱成長，從不修剪（只有 `clear()`）；只有會鑄造唯一 frame id 的 publisher 會踩到。
- `meshCache`（`meshLoader.ts:13-48`）以 URI 為 key 永不淘汰，受限於不同 URI 的數量。

## 3. Rust 端

### 3.1 server：每 session 一次 6 MB memcpy；WT 路徑的丟棄未計數

- `hub.rs:154-162`：`Bytes` 的 `clone()` 是 refcount，fan-out 無拷貝；slot（`hub.rs:44-61`）latest_only 保留 1 筆、reliable 保留 depth 筆，都有上限。
- **`session.rs:362-366`**：`buf.reserve(13+len)` + `put_slice(header)` + `put_slice(&frame.payload)` → 每個 frame 每個 session 一次 6 MB 配置 + 6 MB memcpy（/points 10 Hz = 60 MB/s/viewer）；frozen `Bytes` 還被 WS sink 或 WT task 持有，`BytesMut::reserve` 無法重用 → 每次新配（page-fault churn）。WS 需要連續 buffer，這份拷貝在 WS 路徑無法避免；**WT uni-stream 路徑可以用兩次 `write_all`（header、payload）完全省掉**。
- 慢客戶端上限：1 筆佇列 + 1 筆 writer buffer + `MAX_IN_FLIGHT = 2`（`session.rs:581`）個 WT stream ≈ 4 × 6 MB = 24 MB/session，有界。
- **`session.rs:641-644`**：2 個 WT stream 在飛時直接丟棄並回傳 `true`（「已送」），但 `slot.dropped` 只在 hub 增加 → WT 路徑的丟棄統計低估。Tier 0 沒有未計數的丟棄。
- WS 背壓：`ws_tx.send().await` 在 TCP 滿時卡住唯一的 writer loop，同一個 loop 也送 `clock`、`topics`、`error`（`session.rs:392-396`）→ 擁塞時 clock 抖動。建議控制訊息獨立 writer。
- `session.rs:358` 每次喚醒 `writer_subs.lock()` + `collect::<Vec<Arc<Slot>>>()`（mock 下每 session 每秒 100+ 次喚醒 × ~20 個 sub ≈ 2k Arc clone + 2k lock/s），便宜但不必要；建議用 generation counter 快取。
- `hub.rs:140-144` `Hub::subscribe` 持有 `inner` Mutex 跨 `transport.subscribe_raw`（r2r 要繞 spin thread，最多 `SPIN_TIMEOUT` 10 ms）→ 同時的 `detach` 會卡 tokio worker 10 ms。非每訊息。
- `hub.rs:18-23` 訂閱 key 含 `depth` → 兩個 viewer 要不同 depth 的 /points 會建兩個 ROS subscription，DDS 把 6 MB 送兩次進程序。建議 key 只含 reliability/durability，depth 由 slot 自己管。
- `mesh.rs:447-451` 整個檔案讀進記憶體回傳，沒有 `Cache-Control`/`ETag` → 每次 reload 重抓多 MB 的 mesh；`ament_prefixes()` 每請求重解析兩次（`:384-391, 401, 412`）。
- WT datagram 無序而 `worker.ts:262-277` 不檢查 `receive_time_ns` 順序 → 舊的 best-effort datagram 可能蓋掉新的（語意問題，非效能）。

### 3.2 bridge / mock

- `mock.rs:972-1013` `/points`：`Writer::with_capacity`（≈6 MB）**加上**第二個 6 MB `buf` 逐點填滿再 `w.bytes(&buf)` memcpy → 每 tick 2 × 6 MB 配置 + 1 × 6 MB memcpy + 299k 次 sqrt/sin/exp；`:162-167` `receiver_count()` 檢查在編碼之後 → **沒有訂閱者也每 100 ms 編一次 6 MB**。
- `/livox/lidar` 10 Hz（`:238-251, 691-744`）：24,000 × 約 8 個三角函數，在 runtime worker thread 上，不像 /points 走 `spawn_blocking`（Tier 0 已如此）。
- 相機 5 Hz（`:189-223, 518-595`）：每像素重算 `yaw.cos()/sin()`（`:532-533`）；50 ms 迴圈 **inline await** 這個 `spawn_blocking`（`:212-215`）→ 每第 4 個 tick 的 `/odom`、`/range`、`/footprint`、`/camera_info` 延後，/odom 時序抖動（新）。
- `latched`（`:98, :293`）不分 QoS 保留每個 channel 的最後一筆（/points +6 MB），有界。
- `r2r_transport.rs:203-214`：`Vec<u8>` → `Bytes::from` 零拷貝；rmw → Vec 的拷貝在 r2r 內部。

### 3.3 core

- PointCloud2 見 §2.1；`cdr.rs` Reader 每個 primitive 做 align + bounds check + endianness 分支，只有 `f32_seq_into` 是 bulk 路徑（LaserScan）。
- `tf.rs:197-245` `lookup` 每次兩個 `Vec<usize>` 配置；`insert` 修剪到 10 s cache，有界。
- `covariance.rs:31-93` Jacobi：mock 的對角 covariance 一輪就收斂，1 到 3 µs；`pose_cov_data`（`lib.rs:396-442`）每訊息 serde 解析 options JSON + worker 端每訊息 `JSON.stringify`（`decoders.ts:117`）是唯一可省的。
- `image.rs:89-244`：rgb8 迴圈每像素 slice 索引（bounds check 可能未消除）；depth 兩次 pass；median window 是每幀一次不是每像素，沒問題。
- `marker.rs:55-119` 每 marker 2 到 4 個 String。

### 3.4 wasm 邊界（`crates/wasm/src/lib.rs` + glue）

所有回傳結構用 `#[wasm_bindgen(getter_with_clone)]`（`PointCloudData` `:749-767`、`MarkerArrayData` `:943-950`、`ImageData` `:454-462`、`PoseCovData` `:336-348`）→ 每個 Vec 欄位：Rust clone 一次 + JS `.slice()` 一次 + `__wbindgen_free` clone。輸入 `&[u8]` 由 `passArray8ToWasm0` 複製進 wasm。`point_info_json`（`:84-129`，Tier 1 新增）為一個點複製 6 MB 並跑完整 `points_from_cloud2`。建議：(a) decoder 讀完就 `.free()`；(b) 改成 `take_*` 回傳 `Vec<f32>` by value（只複製一次）；(c) `fill(&mut [f32])` 寫進呼叫端可重用的 buffer；(d) `ImageConverter::convert` 用 `&mut [u8]` out-param。

## 4. 拾取、Selection、UI 反應式

### 4.1 拾取（`web/src/render/picking.ts`）：成本在「再畫一次場景」與同步 readback

`Picker.doPick`（`:116-182`）每次拾取：

1. `:109-114` 以 promise 串行化，呼叫端仍會排隊。
2. `:121-127` box 尺寸（device px）變了就 `target.setSize` → 重配 RGBA Float 貼圖 + depth；hover 的 1×1 穩定，不同大小的框選每次重配（全視窗 dpr 2 ≈ 45 MB）。
3. `:130/:150` `setViewOffset` 讓 frustum 只剩 box，`frustumCulled=true` 的物件會被剔除；但點雲、instanced pool、線段都是 `frustumCulled=false`（`instancedShapes.ts:58`、`instanced.ts:27,44,103,153`）→ **1×1 拾取也把它們全畫**。
4. `:220-234` `prepareScene` 每次拾取 `scene.traverse` 全圖切 `noPick`/`pickOccluder`，`restoreScene` 再走一次；render 本身第三次走（`_projectObject`）。
5. `:142-144` 用 `PICK_MRT` 再 render 一次：CPU 成本 ≈ 正常一幀的 render section（draw call 提交不因 box 變小而少）；每個 render object 的 `pickIdUniform.onObjectUpdate`（`:72-80`）往上走 parent 到 root。
6. **首次 64 到 200 ms = pipeline 編譯**：`setMRT` 讓 `RenderContexts` 用 `mrt.id` 開新 context，`RenderObjects` 對每個 (object, material) 建新 RenderObject，`NodeMaterial.setupOutput` 換掉 fragment 輸出 → 場景裡每種 material 編一個新 program（WebGL 同步 `compileShader/linkProgram`）。之後新增的 material（新 cloud slot、新 marker material、新 Box3Helper）在下次拾取補編。
7. `:153, :189-209` readback：WebGL 路徑 `gl.readPixels(FLOAT)` **同步**，CPU 等 GPU 把拾取 render 和前一幀都做完；每次 `new Float32Array(tw*th*4)`（16 B/device px，不重用）。WebGPU 路徑 `readRenderTargetPixelsAsync` 多一次 `getMappedRange().slice()` 拷貝。
8. `:156-181` 每像素迴圈：覆蓋像素 2 次 `Math.round` + Map 查找，新的或更近的像素 2 次 `applyMatrix4` + 一個 `PickHit` + 一個 `Vector3`；點雲每像素都是不同 instance → 全視窗可達數十萬個 hit，`[...hits.values()]` 再複製。
9. `:86, :123` `MAX_PICK_PIXELS = 1_000_000` 以 **CSS px** 檢查：超過 1 MP 的視窗全選靜默回傳 `[]`；dpr 2 時實際讀回 4 倍（4 MP × 16 B = 64 MB）。

對照量測：10×10 的 12 到 24 ms ≈ 一次額外的全場景 draw 提交（步驟 5）+ `gl.readPixels` 的 GPU 排空（步驟 7），像素迴圈可忽略；全視窗 21 到 37 ms 再加 readback 位元組與 O(像素) 迴圈；首次 64 到 200 ms 是步驟 6。

呼叫端：`select.ts:77` 只在放開滑鼠時拾取一次；**`publishPoint.ts:280-294` 與 `focusCamera.ts:355-362` 在工具啟用、沒按鍵時每 ≥50 ms hover 拾取一次**，結果每次組新座標字串 → `innerHTML` + cursor style；`measure.ts:195-206` 只在 `lineStarted` 時 hover 拾取。以 20 Hz × 12 到 24 ms 計，Publish Point / Focus Camera 懸停時主執行緒每秒有 240 到 480 ms 在同步拾取裡，是 Tier 1 最大的單一互動成本。`Viewport.pick/pickPoint`（`Renderer.ts:168-175`）先 `resize()` 讀 `clientWidth/Height`（前一次拾取寫了 status bar innerHTML → 強制 layout）。

建議：readback buffer 以最大尺寸重用一個；`noPick` 物件改放到拾取相機不測的 layer，省掉 `prepareScene` traverse；第一幀後做一次 1×1 拾取預熱 pipeline；`visibilityState === 'visible'` 時用非同步 fence；hover 降到 ≤10 Hz 且 `busy` 時跳過；`MAX_PICK_PIXELS` 以 device px 計並以 dpr 1 畫框選；`worldPos` 對每個最終 key 算一次。

### 4.2 Selection（`web/src/app/selection.ts`）

- `apply`（`:46-72`）每個 hit：`describeSelection` 建 Property 子樹（每個 Property 5 個 `createSignal`，`Property.ts:54-58`；marker hit ≈ 17 個 Property ≈ 85 個 signal；點雲 hit 另有 `describePoint` worker 來回），`treeRoot.addChild` → `Property.ts:112-118` `includes` O(n) + `slice` O(n) + **每個 hit 一次 `setChildren` signal 寫入、沒 batch** → O(hits²)，Selection panel 掛載時每次寫入都重跑 PropertyTree 的 `rows` memo 並重建所有可見列（§4.3）；再每個 hit 一個 `Box3Helper`（各自 geometry + material）。`clear()`（`:91-94`）每項 `removeChild` = `filter` O(n) + signal 寫入 → replace 模式一次拾取 n 項要 2n 次未批次的 children 寫入。
- `update()` 見 §1.5。
- 建議：`apply/clear` 包 `batch()` 並一次 `setChildren(newList)`；高亮框共用 material 或合併成一個 `LineSegments`。

### 4.3 Property 系統與 PropertyTree（與 Tier 0 相同）

`PropertyTree.tsx`、`editors.tsx`、`DisplaysPanel.tsx` 與 Tier 0 無差異；`Property.ts` 只多 `setDescription`。

- **沒變的 status 寫入不碰 DOM**：`setStatus` 經 `equals`（`Property.ts:82`）與 Solid `===` 去重，成本是 O(statuses) 的 `child(name)` find + 1 到 2 個字串。
- **`children()` 是 signal → 整棵樹重算並重建所有可見列**：`PropertyTree.tsx:108-111` `rows = createMemo(flattenRows)` 讀展開樹裡每個節點的 `children()`、`hidden()`、孫節點的 `children()`、`name()`；任何 `addChild/removeChild/setHidden/setName` 都重跑整棵可見樹，且 `flattenRows` 產生新的 `Row` 物件 → `<For each={visible()}>`（`:146`）視為全新 key，**銷毀並重建所有掛載的 `TreeRow`**（每列 6 到 10 個 DOM 節點 + editor；600 px 面板約 39 列）。觸發者：新 status 名稱第一次出現、TF frame 出現/消失（`tfDisplay.ts:143-158`）、marker namespace（`markerDisplay.ts:561-566`）、`poseDisplay.ts:76-79` 8 次未批次的 `setHidden`（8 次重建）、`ToolManager.syncPropertiesRoot`（`:59-63`）、`ViewManager.rebuildTree`（`:66-70` 全刪再全加 → 2(n+1) 次寫入）、每個 selection hit。捲動與 splitter 拖曳不觸發。
- 建議：多子節點變更包 `batch()`；`flattenRows` 以 `prop` 為 key 快取 Row 讓 `<For>` 重用。

### 4.4 狀態列、面板、工具、視圖

- `App.tsx:146` `toolStatus` → `innerHTML`：Publish Point / Focus Camera 懸停時每次拾取結果一個新字串 → **最高 20 Hz 的 innerHTML 解析 + layout**；`:147` FPS 每秒一次；`:150-152` 只在 `?perf` 下；`:165` ROS time 10 Hz 文字更新（Tier 0 相同）。Tier 1 新增的是 `toolStatus` 與 transport 兩個 span。
- `TimePanel.tsx`：10 Hz 四個 `<input value>` 寫入，各一次 BigInt 除法 + `toFixed(2)`；Tier 0 是空殼。
- `ImagePanel.ts`：只在訊息時工作，無每幀成本。`CameraPanel.ts:105` 第二個 renderer/context，場景 material 全部再編一份；`:148-177` 每幀讀 layout、最多 3 次 render（見 §1.1）。
- `input.ts:323-329, 355-362`：每個 pointer event 一個事件物件 + `getBoundingClientRect()`（DOM 剛被 status bar 弄髒時強制 layout）。`measure.ts:183` 每個 pointer event 組一次 status 字串（DOM 前去重）。`select.ts:64-68` 拖曳時每 move 一個 box 物件 + 5 次 style 寫入。`poseTool.ts:508-531` 拖曳時用共享暫存，無配置。
- 視圖：`orbit.ts:83-85` 每 move 兩次 `setValue('user')`，各自觸發 `updateCamera` → 每 mousemove 跑 2 次 + 每幀 1 次；`pan`/`moveAlongView`（`:97-107`）每 move 配置 `{x,y,z}` + normalize 複製，扇出 1+3 次 signal 寫入到 Views 面板 DOM；`topDownOrtho.ts:153` 每幀 `updateProjectionMatrix`。
- `layout.ts` 無每幀工作；但 `Renderer.ts:127` 每幀讀 `clientWidth/Height`，把上述所有 UI 的 DOM 寫入變成下一幀開頭的一次 reflow。

## 5. 與量測數字的對照

| 量測 | 靜態分析的解釋 |
|---|---|
| B2 − A2 = +0.05 到 +0.10 ms | 幀迴圈新增項全是 O(1)/O(selected)（§1 表）；TF 的 pickable 登錄與 selection hook 不在每幀路徑 |
| B − B2 = 0.5 ms vs A − A2 = 0.2 ms（TF display） | Tier 1 mock 11 個 frame × 9 個 Object3D；同一批 drawable 在 Tier 1 多被 Camera traverse / 拾取 pass 消費（§1.4） |
| C ≈ B（WebTransport 無主執行緒成本） | 接收與重組都在 worker（`worker.ts:139-192`）；多出的拷貝只在走 WT 的 best-effort topic（§2.8） |
| D 的 render 4.4 ms、236 draw call | Odometry 185 個可繪物件、500 個獨立 material 走透明排序（§1.2）；TF 66；RobotModel 66 個節點 |
| D − E = 2.6 到 3.6 ms（Camera） | 第二個 renderer 把整個場景再畫一次 + 每幀全場景 layer traverse + O(D²) syncVisibility（§1.1） |
| D 的 long frames 與訊息無關 | 長幀的 render 7.7 到 10.6 ms：236 個 draw call 畫兩次的 GPU 提交抖動；訊息處理在別的 task（§2.2） |
| 拾取 10×10 ≈ 12 到 24 ms | 全場景再畫一次（frustumCulled=false 的點雲照畫）+ 同步 `gl.readPixels`（§4.1） |
| MarkerArray 處理兩版相同 | `makePickable` 是 O(1) Map 操作（§2.8） |
| JS heap 30 s 內不成長 | 成長點在 wasm 線性記憶體（不計入 JS heap）與 worker 的 `recent` 陣列（每小時 ~15 MB，30 s 看不出）（§2.9） |

## 6. 建議修正（依收益排序）

**2026-10-09 更新：第 1 到 5 項已實作**（commit `19792d6`、`0c03b8d`、`c046722`、`0d724f5`、`dd658f3`），結果見 `docs/perf-tier1-vs-tier0.md` 第 8 節。第 5 項的「noPick 改 layer」沒有做：three.js 的 layer 不會被子物件繼承，登錄表又要追蹤之後加進 display 的每個物件，而 traverse 的成本相對於拾取 render 本身可忽略（`docs/todo.md` 有記）。其餘項目仍未做。

| # | 項目 | 位置 | 預期效果 | 工作量 |
|---|---|---|---|---|
| 1 | Camera：visible 檢查提前、layer bit 事件驅動、只在新影像/TF/pose 變動或 ≤15 Hz 重畫 | `cameraDisplay.ts:160-229`、`CameraPanel.ts:475` | D 8.7 → 約 6 ms，long frames 歸零 | 小 |
| 2 | Odometry/PoseWithCovariance covariance 改 InstancedMesh、共用 material | `covarianceVisual.ts`、`odometryDisplay.ts:129-140` | D/E render 4.2 → 接近 1.5 ms；Camera view 同步受益 | 中 |
| 3 | 主執行緒 latest-only `pending` 槽 + worker in-flight 閘 | `client.ts:80-81`、`worker.ts:291-296`、`Renderer.ts:129` | 訊息率 > 幀率時不再重複套用；佇列有上限 | 中 |
| 4 | wasm 回傳改 view / `take_*` 並 `.free()`；FLOAT32/LE 快速路徑；identity 快速路徑；rainbow LUT | `lib.rs:749`、`decoders.ts`、`pointcloud.rs:147-195, 314-416` | 每點雲訊息少 9 MB 拷貝 + 4.5 MB 常駐垃圾；worker CPU 降 | 中 |
| 5 | 拾取：readback buffer 重用、hover ≤10 Hz 且 busy 時跳過、noPick 改 layer、pipeline 預熱、MAX_PICK_PIXELS 以 device px 計 | `picking.ts`、`publishPoint.ts:280`、`focusCamera.ts:355` | 懸停時主執行緒佔用從 24 到 48% 降到 <10%；首次點擊無卡頓 | 中 |
| 6 | RobotModel pose 列 5 Hz 或列可見才寫；TF `syncFrameList` 以 `framesVersion` 觸發、RegExp 快取、alpha 變才 setOpacity | `robotModelDisplay.ts:556-596`、`tfDisplay.ts:121-162` | 去掉每幀每 link/joint 的配置與 signal 寫入 | 小 |
| 7 | WT uni-stream 兩次 `write_all` 省掉 6 MB memcpy；丟棄計入 `slot.dropped`；控制訊息獨立 writer | `session.rs:362-372, 641-644` | 每 viewer 省 60 MB/s 記憶體流量；統計正確 | 小 |
| 8 | MarkerArray：字串 table + 索引、tf lookup 記憶、錯誤 status 彙整並刪除 | `lib.rs:952-1018`、`decoders.ts:252`、`markerDisplay.ts:166-171` | 1 Hz 路徑配置數從萬級降到個位數；/tf 晚到時不再建 5,016 列 | 中 |
| 9 | `worker.ts:277` `recent` 在 `onFrame` 修剪（Tier 0 也有） | `worker.ts:277, 320` | 修掉 ~15 MB/小時的成長 | 極小 |
| 10 | Odometry 去掉重複 `redraw()`、append-only、環形緩衝 | `odometryDisplay.ts:101-108` | 20 Hz 路徑成本減半 | 極小 |
| 11 | `batch()` 包住 `manager.update()`、selection apply/clear、`rebuildTree`、`syncPropertiesRoot`、`poseDisplay` 的 8 次 setHidden；`flattenRows` 以 prop 為 key 快取 Row | `Renderer.ts:129`、`selection.ts:46-94`、`ViewManager.ts:66-70`、`PropertyTree.tsx:108-146` | 樹變更時不再重建所有可見列 | 小 |
| 12 | `setStatus` 先比較 (level, text)；呼叫端只在轉換時呼叫；`measure` 閉包在 perf 關閉時不建 | `Property.ts:553-562`、`Renderer.ts:129-131` | 去掉每幀每 display 的字串與閉包配置（§9.7） | 小 |
| 13 | mock：`receiver_count` 檢查移到編碼前、去掉第二個 6 MB buf、livox 走 `spawn_blocking`、相機 render 不 inline await | `mock.rs:162-167, 212-215, 992-1010` | 無訂閱者時不浪費 6 MB/100 ms；/odom 時序不抖 | 小 |
| 14 | hub 訂閱 key 去掉 depth；`subscribe` 不持鎖跨 `subscribe_raw`；mesh API 串流 + 快取標頭 | `hub.rs:18-23, 140-144`、`mesh.rs:447-451` | 多 viewer 不重複 DDS 訂閱；reload 不重抓 mesh | 小 |
| 15 | WebGPU 時點雲顏色改 Uint8×4 或 packed Uint32 | `pointCloud.ts:37`、`markerDisplay.ts:240-251` | 真 WebGPU 上每訊息省 2 MB 配置 + 52 萬次 `subarray` | 小 |

另外：`crates/wasm/target/`（344 個檔案、93 MB）在 `8eefc11` 被誤 commit，`4e6907e` 已加 `.gitignore` 並移出索引；分支尚未 push，歷史裡的 blob 要不要用 `git filter-branch`（或重做這四個 commit）清掉，由使用者決定。
