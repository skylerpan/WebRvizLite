# 效能比較：Tier 1 vs Tier 0

量測日期 2026-10-09，兩輪：第一輪在獨立的乾淨 profile Chrome 視窗（DevTools Protocol），第二輪在使用者自己的 Chrome 分頁（Claude 擴充功能注入同一套探針，分頁保持前景）。兩輪結論一致；主表為第一輪，第二輪見第 7 節。比較對象：

| | commit | 分支 | 內容 |
|---|---|---|---|
| Tier 0 | `2d7ee6e` | `origin/master` | M0–M7 |
| Tier 1 | `8eefc11` | `feature/tier-1` | M8–M15 + rviz lyrical 對照修正 |

結論先講：

- **同一個 Tier 0 場景**下，Tier 1 每幀主執行緒時間從 1.70 ms 增為 2.03 ms（第二輪 1.83 → 2.12）。但其中大半來自 Tier 1 mock 的 TF tree 多了 6 個 frame（TF display 多畫 36 個物件）；把 TF display 關掉後兩版是 1.49 vs 1.54 ms（第二輪 1.54 vs 1.64），**純框架開銷（拾取登錄、Selection、Tool/View 框架）只有 +0.05–0.10 ms/幀（3–6%）**。FPS、long frames 都沒有變化（兩版同樣受 Frame Rate 30 上限、0 long frames）。
- **WebTransport** 對主執行緒沒有可量到的成本（C−B = 0.02 ms，在誤差內）；它只改變傳輸路徑，解碼仍在 worker。
- **Tier 1 全量場景**（22 個 display，含 Camera 第二 renderer）每幀 8.7 ms（第二輪 7.2），30 秒內有 11（第二輪 4）個 >16 ms 的幀；關掉 Camera 後 5.1 ms（第二輪 4.6）、0 long frames。**Camera display 的第二次場景渲染是最大的單一成本（2.6–3.6 ms/幀）**，其次是 Odometry 100 箭頭 + 100 covariance 帶來的 draw call 數（79 → 236）。
- 前端 bundle gzip 後 +60 KB（+11%），wasm +26 KB gzip，server 執行檔 +4.2 MB（WebTransport/QUIC 與 TLS）。
- 沒有發現需要立即修正的退化；建議的後續優化列在最後一節（本次只列不改）。

## 1. 環境與方法

| 項目 | 值 |
|---|---|
| CPU / RAM | i7-11370H（8 執行緒）/ 23 GB |
| GPU | RTX 3060 Laptop，driver 470.256 → Chrome 無 WebGPU，three.js 退回 **WebGL2** backend（兩版相同） |
| Chrome | 154.0.8037.97，獨立 profile、無擴充功能，視窗 1600×1000 前景；用 DevTools Protocol（`--remote-debugging-port`）注入探針 |
| 工具鏈 | rustc 1.99.0、Node 24.15、wasm-pack、Vite |
| server | 各版自己的 release 執行檔，`--mock`，port 8765，前端為執行檔內嵌的 production build |

Frame Rate 在三個設定檔都是 rviz 預設的 30，所以 FPS 固定在 29–30；**真正的比較指標是每幀主執行緒時間**（update + render + extra views）。

### 情境

| # | 版本 | 設定檔 | 傳輸 | 目的 |
|---|---|---|---|---|
| A | Tier 0 | Tier 0 `mock_scene.rviz`（12 display） | WS | 基準 |
| B | Tier 1 | 同 A | WS（`--no-webtransport`） | 框架開銷 |
| C | Tier 1 | 同 A | WS + WebTransport | 傳輸層差異 |
| D | Tier 1 | `tier1_scene.rviz`（22 display，5 panel） | WS + WT | Tier 1 display 的增量 |
| E | Tier 1 | `tier1_scene.rviz`，Camera display `Enabled: false` | WS + WT | 單獨看 Camera 第二 renderer |
| A2 / B2 | Tier 0 / Tier 1 | 同 A，TF display `Enabled: false` | WS | 排除 mock TF frame 數不同的影響 |

mock 資料率（兩版相同的 topic）：`/points` 300k 點 @10 Hz、`/scan` 10 Hz、`/livox/lidar` 10 Hz、`/markers` 5,016 marker @1 Hz、`/tf` 30 Hz、`/clock` 50 Hz。Tier 1 mock 另加 `/odom` 20 Hz、`/range` 10 Hz、`/footprint` 5 Hz、`/camera/image_raw` 640×480 ~4 Hz、`/camera/depth/image_raw` 5 Hz、`/amcl_pose`、`/grid_cells`、`/clicked_point_echo` 等。Tier 1 mock 的 TF tree 有 11 個 frame，Tier 0 mock 只有 5 個（B/C 的 TF display 因此多畫 36 個物件；A2/B2 排除這點）。

### 取樣

每個情境跑 3 次，每次：開新分頁 → 20 s 暖機 → 點 status bar 的 reset → 30 s 取樣。表中為 3 次的中位數（long frames、worst 取最大值）。

- **production 探針**（兩版相同腳本）：包住 `requestAnimationFrame` 量每個 renderer 回呼的主執行緒時間（即 `Viewport.frame`：update + render + camera view）；每秒讀 status bar 的 `N FPS`；結束時讀 `long frames / worst` 與各 section 的「最差 ms × 呼叫次數」；`PerformanceObserver('longtask')`；`performance.memory`、CDP `Performance.getMetrics`。
- **dev 探針**（`vite dev`，`window.__wrl` 只在 DEV 存在）：monkey-patch `Viewport.prototype.frame`、`VisualizationManager.prototype.update`、`renderer.render`、每個 display 的 `processMessage`、Camera 的 `render()`，取平均 / p95；另量 `renderer.info` 的 draw call 數與拾取時間（`vp.pick`，10×10 與全視窗各 10 次）。dev build 比 production 慢約 5–10%，只用來拆分比例，不與 production 表互比。

## 2. 結果（production build）

| 指標 | A Tier 0 | B Tier 1 | C Tier 1 +WT | D tier1_scene | E D−Camera |
|---|---|---|---|---|---|
| FPS 平均 / 最低（上限 30） | 29 / 29 | 29 / 29 | 29 / 29 | 29 / 29 | 29 / 29 |
| 每幀主執行緒 平均 ms | **1.70** | **2.03** | **2.05** | **8.73** | **5.11** |
| 　σ（3 次） | 0.02 | 0.03 | 0.06 | 0.21 | 0.27 |
| 　p50 | 1.60 | 1.90 | 1.90 | 8.30 | 5.00 |
| 　p95 | 2.60 | 3.20 | 3.10 | 12.90 | 7.30 |
| 　p99 | 3.40 | 3.80 | 4.00 | 16.00 | 9.00 |
| 　最大 | 6.8 | 7.5 | 8.7 | 20.9 | 13.8 |
| 主執行緒忙碌 %（幀迴圈 / 30 s） | 4.9 | 5.9 | 5.9 | 25.3 | 14.9 |
| long frames（>16 ms / 30 s，3 次最大） | 0 | 0 | 0 | **11** | 0 |
| worst frame ms（status bar） | 6.6 | 7.3 | 8.6 | 20.9 | 13.7 |
| Long Tasks（>50 ms） | 0 | 0 | 0 | 0 | 0 |
| JS heap 取樣後 MB | 63 | 76 | 77 | 53 | 49 |
| DOM nodes | 952 | 1021 | 1022 | 1365 | 1326 |

JS heap 的差異在 GC 時機的雜訊範圍內（同一情境 3 次相差可到 10 MB），不代表趨勢。

排除 TF frame 數差異（TF display 關閉，其餘同 A/B）：

| 指標 | A2 Tier 0 | B2 Tier 1 | Δ |
|---|---|---|---|
| 每幀主執行緒 平均 ms | **1.49** | **1.54** | +0.05（+3%） |
| 　σ（3 次） | 0.07 | 0.03 | |
| 　p50 / p95 / p99 | 1.40 / 2.30 / 3.00 | 1.50 / 2.40 / 3.10 | +0.1 |
| 　最大 | 5.7 | 5.7 | 0 |
| long frames / Long Tasks | 0 / 0 | 0 / 0 | |
| JS heap 取樣後 MB | 63 | 64 | |
| DOM nodes | 948 | 1011 | +63（新 menu / panel 骨架） |

Status bar sections（最差 ms × 30 s 內呼叫次數；只顯示前 6 名，故部分情境缺項）：

| section | A | B | C | D | E |
|---|---|---|---|---|---|
| update | 2.0 ×854 | 1.9 ×863 | 2.0 ×859 | 2.2 ×860 | 2.3 ×858 |
| render | 4.8 ×854 | 4.8 ×862 | 6.0 ×859 | 10.8 ×859 | 11.5 ×857 |
| camera view | – | – | – | 9.6 ×859 | – |
| tf snapshot | 0.3 ×899 | – | – | – | – |
| msg MarkerArray（1 Hz） | 6.6 ×30 | 6.5 ×30 | 5.8 ×29 | 6.3 ×30 | 6.3 ×30 |
| msg Marker | 1.0 ×30 | 0.9 ×30 | 0.8 ×29 | 2.0 ×30 | 0.7 ×30 |
| msg PointCloud2（10 Hz） | 0.9 ×297 | 0.9 ×300 | 0.9 ×299 | 1.0 ×297 | 1.2 ×298 |
| msg Livox | 0.3 ×300 | 0.2 ×300 | 0.2 ×299 | – | – |
| msg LaserScan | – | – | 0.3 ×298 | – | – |
| msg Odometry（20 Hz） | – | – | – | 1.7 ×596 | 1.5 ×596 |

呼叫次數確認兩版收到相同的資料率（PointCloud2 ≈ 300 / 30 s = 10 Hz，MarkerArray 1 Hz，Odometry 20 Hz）。

## 3. 拆分（dev build，單次 30 s）

| 平均 ms / 幀 | A Tier 0 | B Tier 1 | D tier1_scene | E D−Camera |
|---|---|---|---|---|
| frame 合計 | 1.82 | 2.48 | 9.18 | 5.37 |
| 　update | 0.75 | 1.08 | 1.18 | 1.13 |
| 　render（主視圖） | 1.04 | 1.34 | 4.44 | 4.16 |
| 　camera view | – | – | 3.48 | 0.00 |
| update p95 / render p95 | 1.3 / 1.6 | 1.8 / 2.1 | 1.8 / 6.8 | 1.7 / 6.4 |
| 訊息處理合計 ms / 30 s | 258 | 306 | 437 | 434 |
| 　msg MarkerArray 平均 | 2.38 | 3.09–3.74 | 3.26 | 3.26 |
| 　msg PointCloud2 平均 | 0.50 | 0.49 | 0.50 | 0.51 |
| 　msg Odometry 平均 | – | – | 0.19 | 0.18 |
| 主視圖 draw calls / 幀 | 47 | 79 | 236 | 236 |
| 場景物件 / 可繪物件 | 120 / 54 mesh | 176 / 84 mesh | 661 / 393 mesh | 661 / 393 mesh |
| 三角形 / 幀 | 716 k | 717 k | 730 k | 730 k |
| GPU 資源（renderer.info.memory.total） | 12.9 MB | 14.6 MB | 13.6 MB | 13.6 MB |

拾取（Tier 1，WebGL2 同步 readPixels，10 次平均；首次呼叫含 shader 編譯 64–69 ms）：

| | 10×10 px | 全視窗 1600×~850 |
|---|---|---|
| 平均 | 12.4–12.9 ms | 20.7–21.7 ms |
| 命中數 | ~1,800 點 | ~18,000–20,800 點 |

拾取只在點擊/框選或 Select tool hover（50 ms 節流）時發生，不在每幀路徑上；12 ms 中大部分是 WebGL `readPixels` 的同步等待。

## 4. 差異解讀

**B − A = +0.33 ms/幀，其中框架只佔 +0.05 ms（A2/B2）**

- Tier 1 mock 的 TF tree 有 11 個 frame（Tier 0 為 5），TF display 多畫 36 個物件（30 → 66 drawables），draw call 47 → 79：TF display 在 Tier 1 的場景裡要 0.5 ms/幀（B − B2），在 Tier 0 只要 0.2 ms（A − A2）。這是 mock 資料的差異，不是程式碼的差異；TF display 本身的實作兩版相同。
- 真正的框架差異（B2 − A2 = +0.05 ms）來自 `VisualizationManager.update()`（`web/src/displays/manager.ts`）每幀多做的 `views.update`（ViewController 框架）、`selection.update()`（`web/src/app/selection.ts`；沒有選取時是空迴圈）、fixed-frame 狀態比對，以及 render 時多 traverse `selection highlight` / `tool helpers` 兩個空 group。
- `msg MarkerArray`：第一輪 2.4 → 3.1–3.7 ms，第二輪 2.46 → 2.49 沒有差異，所以 Tier 1 每個 marker 的 `makePickable`（`web/src/displays/Display.ts`，登錄到 `PickRegistry` 並寫 `userData.pickId`）成本在雜訊等級（1 Hz，不影響幀時間）。PointCloud2 的解碼在 worker，主執行緒成本 0.5 ms 兩版相同。

**C − B = +0.02 ms（WebTransport）**：best-effort topic 改走 datagram / uni stream 後，主執行緒看不出差異；解碼與重組都在 worker。worst frame 7.3 → 8.6 ms 的差異在單次雜訊內（C 的 3 次分別為 8.6 / 5.7 / 6.6，B 為 5.8 / 5.2 / 7.3）。

**D − E = +3.6 ms/幀（Camera display）**：`CameraDisplay.render()`（`web/src/displays/cameraDisplay.ts`）用第二個 `WebGPURenderer` 把整個場景（含 300k 點雲、5,016 marker、Odometry）以相機視角再畫一次到 Camera panel 的 canvas；成本等於再跑一次主視圖的 render（4.4 ms vs 3.5 ms，Camera panel 解析度較小）。它每幀都跑，不管影像有沒有更新（影像 ~4 Hz）。

**E − B = +3.1 ms/幀（Tier 1 新 display 的場景）**：主視圖 render 1.34 → 4.16 ms，draw call 79 → 236，物件 176 → 661。來源（dev 探針逐 display 計數）：Odometry 185 個可繪物件（顯示中 77 個：100 支箭頭各一個 mesh，加上 `CovarianceVisual`（`web/src/render/covarianceVisual.ts`）的橢球 / 三個圓盤 / 扇形各自是獨立 mesh，2D 模式下只顯示一部分）、RobotModel 66 個節點（7 個 link mesh 加上每個 link/joint 的 axes 與 trail 節點）、TF 66、AMCL Pose 10，GridCells/Polygon/Range/PointStamped 各 1。update 只多 0.05 ms（Odometry 的 tf 重算在 `processMessage`，20 Hz，每次 0.19 ms）。Image display 兩個 panel 的 `putImageData`（`web/src/panels/ImagePanel.ts`）在訊息路徑上，每次 0.05–0.07 ms，可忽略。

**D 的 11 個 long frames**：平均 8.7 ms、p95 12.9 ms，尾端自然就碰到 16 ms。用 dev 探針把 >16 ms 的幀和前一秒的訊息對照，這些幀**不**跟 MarkerArray 重建或影像訊息同步，而是主視圖 render 本身的尖峰（這些幀的 render 為 7.7–10.6 ms，平均 4.4 ms）再加上 camera view 的 3.5 ms；也就是 WebGL2 backend 下 236 個 draw call 畫兩次的抖動。沒有 >50 ms 的 Long Task，UI 不會卡頓，但 30 FPS 的節奏在那些幀會掉一拍。E（關 Camera）後 p99 9 ms、0 long frames。

**JS heap**：Tier 1 多了 dockview、面板與 PickRegistry，但 30 s 內無成長（D 的增量 +1.6 MB 在 GC 雜訊內）；三次取樣沒有看到洩漏跡象。

## 5. 靜態指標

| | Tier 0 | Tier 1 | Δ |
|---|---|---|---|
| Rust 行數（crates/） | 5,862 | 8,386 | +43% |
| TS/TSX 行數（web/src，不含 wasm/pkg） | 7,866 | 13,259 | +69% |
| cargo tests | 45 | 59 | +14 |
| vitest tests | 28 | 44 | +16 |
| 主 JS（minified / gzip） | 1,581.5 / 427.7 KB | 1,720.4 / 459.5 KB | +32 KB gzip（dockview、三個新 panel、三種 view、六個新 display） |
| worker JS | 25.1 KB | 44.5 KB | +19 KB（WebTransport client、image 轉換、新 decoder） |
| wasm（/ gzip） | 205.7 / 91.7 KB | 278.2 / 117.8 KB | +26 KB gzip（covariance 特徵分解、image 轉換、新訊息 decoder） |
| CSS gzip | 12.2 KB | 12.4 KB | – |
| `web/dist` 合計（/ gzip） | 1.96 MB / 531 KB | 2.19 MB / 591 KB | +11% gzip |
| server 執行檔（release，內嵌前端） | 7.49 MB | 11.64 MB | +4.2 MB（wtransport/quinn/rustls、mesh API） |
| `cargo build --release`（workspace crates，相依已快取） | 10.6 s | 16.6 s | |
| `wasm-pack build --release`（同上） | 8.0 s | 9.3 s | |
| `vite build`（暖快取） | 2.8 s | 3.5 s | |

首頁載入沒有量（兩版皆單一 bundle，差 60 KB gzip，區域網路下 <0.1 s）。

## 6. 建議的後續優化（本次只列不改）

依收益排序：

1. **Camera display 節流**：`CameraDisplay.render()` 只在收到新影像、TF 變動或相機 pose 變動時重畫，或限制在 ≤15 Hz；可把 D 的 8.7 ms 降到約 6.9 ms，long frames 預期歸零。rviz 本身的 Camera 也是每幀畫，但它在獨立執行緒。
2. **Odometry 的箭頭與 covariance 改成 InstancedMesh**：目前每支箭頭、每個橢球 / 圓盤都是獨立 mesh（Odometry 一個 display 就佔 185 個物件、主視圖 236 個 draw call 的大半）；箭頭一組、橢球一組、圓盤一組的 InstancedMesh 可把 D/E 的 render 從 4.2 ms 壓回接近 B 的 1.3 ms，Camera view 也同步受益。
3. **MarkerArray 的 pickable 登錄**：改為整個 MarkerArray 一個 pickId + instance index（像 PointCloud 那樣），省掉每個 marker 的 `makePickable`；只影響 1 Hz 的訊息路徑，而且第二輪量不到差異，優先度低。
4. **`CameraDisplay.update()` 每幀跑 `syncVisibility()`**（走一遍 `rootDisplays()` 建 Map）：改為 display 增減時才同步。目前成本在 update 的 0.05 ms 內，優先度低。
5. `camera view` 的 `syncVisibility`/`layers` traverse 在 Visibility 切換時會 traverse 整個 display 子樹；僅在切換時發生，不需處理。

## 7. 第二輪：使用者 Chrome 分頁（擴充功能）重測

同一天稍後，在使用者正在使用的 Chrome 視窗（1848×1053、AnyDesk 遠端桌面連線中、分頁群組內的分頁保持前景）用 Claude 擴充功能注入同一套探針，流程相同（每情境 3 次，20 s 暖機 + 30 s 取樣，結果 POST 到本機收集器）。

| 指標 | A | B | C | D | E | A2 | B2 |
|---|---|---|---|---|---|---|---|
| FPS 平均 / 最低 | 20.8 / 12 | 20.8 / 11 | 20.9 / 12 | 19.5 / 14 | 19.9 / 10 | 21.1 / 14 | 21.3 / 13 |
| 每幀主執行緒 平均 ms | **1.83** | **2.12** | **2.02** | **7.18** | **4.57** | **1.54** | **1.64** |
| 　σ（3 次） | 0.09 | 0.01 | 0.06 | 0.01 | 0.09 | 0.02 | 0.16 |
| 　p50 / p95 / p99 | 1.7 / 3.1 / 4.1 | 1.9 / 3.6 / 4.5 | 1.8 / 3.3 / 4.7 | 6.8 / 10.9 / 14.7 | 4.3 / 6.8 / 9.1 | 1.5 / 2.6 / 3.2 | 1.5 / 2.8 / 3.6 |
| 　最大 | 6.0 | 7.1 | 12.1 | 20.4 | 13.0 | 4.6 | 7.7 |
| long frames（>16 ms / 30 s，3 次最大） | 0 | 0 | 0 | **4** | 0 | 0 | 0 |
| worst frame ms（status bar） | 6.3 | 7.0 | 12.1 | 20.4 | 13.0 | 4.5 | 7.7 |

每次的每幀平均：A 1.83 / 1.97 / 1.74，B 2.12 / 2.13 / 2.10，C 1.91 / 2.02 / 2.04，D 7.18 / 7.18 / 7.20，E 4.54 / 4.57 / 4.74，A2 1.55 / 1.54 / 1.51，B2 1.64 / 1.98 / 1.62。D 的 long frames 每次 3 / 4 / 1。

dev build 拆分（單次）：

| 平均 ms / 幀 | A Tier 0 | B Tier 1 | D tier1_scene | E D−Camera |
|---|---|---|---|---|
| frame 合計 | 1.87 | 2.42 | 7.61 | 5.21 |
| 　update | 0.68 | 0.86 | 1.00 | 1.16 |
| 　render | 1.15 | 1.47 | 3.69 | 3.89 |
| 　camera view | – | – | 2.77 | 0.00 |
| msg MarkerArray 平均 | 2.46 | 2.49 | 2.69 | 2.94 |
| msg PointCloud2 平均 | 0.45 | 0.46 | 0.46 | 0.46 |

與第一輪的差異：

- **結論相同**：B − A = +0.29 ms，排除 TF 後 B2 − A2 = +0.10 ms；WebTransport（C）與 B 無差異；Camera 第二 renderer D − E = 2.6 ms；關掉 Camera 後 0 long frames。所有情境的排序與比例都一致。
- **FPS 只有 20–21（第一輪 29）**：這個視窗的 rAF 節奏被 GPU process 拖慢（量測時 Chrome 的 GPU process 吃滿一顆核心，應是 AnyDesk 的畫面擷取加上較大的視窗），兩版一樣受影響，所以不影響比較，但絕對值不能和第一輪互比。每幀主執行緒時間反而略低（D 7.2 vs 8.7 ms），因為幀數少、每幀之間 GPU 佇列較空。
- 每次都有 1 個 >50 ms 的 Long Task，發生在取樣開始（點 reset 後 Solid 重繪 status bar）之前後，與渲染無關。
- MarkerArray 的訊息處理兩版相同（2.46 vs 2.49 ms），第一輪的 +0.7–1.3 ms 沒有重現，判定為雜訊。

## 附錄：原始數據摘要（每次取樣的每幀平均 ms）

| 情境 | run 1 | run 2 | run 3 |
|---|---|---|---|
| A Tier 0 | 1.74 | 1.70 | 1.69 |
| B Tier 1 | 2.03 | 1.96 | 2.03 |
| C Tier 1 +WT | 2.11 | 2.05 | 1.96 |
| D tier1_scene | 8.73 | 8.73 | 8.29 |
| E D−Camera | 5.11 | 4.99 | 5.61 |
| A2 Tier 0 −TF | 1.49 | 1.63 | 1.47 |
| B2 Tier 1 −TF | 1.58 | 1.54 | 1.51 |

long frames 每次：D = 11 / 8 / 5，其餘全為 0。worst frame 每次：A 5.0 / 6.3 / 6.6，B 5.8 / 5.2 / 7.3，C 8.6 / 5.7 / 6.6，D 18.9 / 20.9 / 20.9，E 13.7 / 11.7 / 13.4，A2 5.5 / 5.5 / 5.6，B2 4.6 / 5.7 / 4.7。

探針腳本（`cdp.mjs`、`probe-prod.js`、`probe-dev.js`、`run.sh`，第二輪另有 `collector.mjs` 與注入用的 `inject-*.js`）與每次取樣的完整 JSON（第一輪 `res-*.json`、第二輪 `ext-*.json`）留在量測機的工作暫存區；報告內的每個數字都來自這些檔案。
