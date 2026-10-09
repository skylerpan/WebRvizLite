# Known issues / TODO

Problems that are understood but not fixed yet. Each entry has the cause traced
to the code and a proposed fix. Runtime problems with a fix already in place are
in [`running.md`](running.md); build-time ones in
[`build-troubleshooting.md`](build-troubleshooting.md).

## Fixed Frame change: status loss and placement glitch

Found while tracing "Map display disappears after changing the Fixed Frame"
(fixed; see [`running.md`](running.md)). Same root cause (`fixedFrameChanged()`
→ `reset()` → `status.clear()`) unless noted. Not covered by the Map override.

- **Every display loses its `Topic` status, including subscribe errors.** The
  base `reset()` clears all status entries, but `subscribe()` writes `Topic`
  only once (`Display.ts` L134-144). The subscription stays active, so an
  error such as a missing typesupport is never shown again until the display
  re-subscribes.
- **Map `Update Topic` errors disappear the same way.** That entry is only
  written in `resubscribeUpdates()` (`mapDisplay.ts` L107-119), which a frame
  change does not run.
- **One-frame placement glitch right after the switch.** `context.fixedFrame()`
  changes on the main thread immediately (`manager.ts` L67-68), but the TF
  snapshot used by `context.tf.lookup()` is only replaced when the worker
  answers `set_fixed_frame` (`web/src/worker/worker.ts` L247-250 →
  `postTfSnapshot()`). `TfSnapshot.lookup()` (`render/tf.ts` L82-94) does not
  check which fixed frame its poses are expressed in, so for the frames in
  between, frame-locked displays are placed with poses relative to the *old*
  Fixed Frame: Map (`mapDisplay.ts` L230), Grid
  (`grid.ts` L90), Axes (`axes.ts` L47), Marker (`markerDisplay.ts` L357) and
  the view controller's target frame (`views/ViewController.ts` L82). It is a
  brief flicker; a fix would stamp the snapshot with its fixed frame and have
  `lookup()` fail (or the displays skip) while it does not match.

## Fixed Frame change clears displays whose transform is baked in at decode time

Displays whose transform *is* baked in by the worker at decode time clear on a
Fixed Frame change as well and cannot recover without the original bytes: PointCloud2 / LaserScan / Livox (their
`reset()` at `pointCloud2Display.ts` L48-51, `laserScanDisplay.ts` L48-51,
`livoxDisplay.ts` L55-58 calls the shared `PointCloudCommon.reset()`,
`pointCloudCommon.ts` L199-202), Marker (`markerDisplay.ts` L522-525), Path
(`pathDisplay.ts` L189-195), Pose (`poseDisplay.ts` L96-100), PoseArray
(`poseArrayDisplay.ts` L117-121). High-rate topics refill on the next message,
but a latched Path or Marker stays blank. To match RViz for those, the worker
would cache the last payload per subscription (`payload.slice()`, because the
payload is a view into the WebSocket buffer, `web/src/worker/worker.ts`
L130-167), and on `set_fixed_frame` (L247-250) re-run `decodeMessage` for
decoders that take `fixedFrame` (`decoders.ts`: path / pose_stamped /
pose_array L88-90, point_cloud2 / laser_scan / livox L126-128, marker /
marker_array L159-160) and post the `data` message again. Limit this to
depth-1 / transient-local subscriptions so 10 Hz clouds are not re-sent.

## Tier 1 notes (2026-10-09)

- **WebGPU backend not exercised for the Tier 1 render passes.** The machine
  this was developed on falls back to WebGL2 (`Renderer: WebGL2` in the status
  bar), so the colour-ID pick pass (`web/src/render/picking.ts`, float MRT +
  `readRenderTargetPixelsAsync`) and the Camera display's second renderer were
  only verified on WebGL2. On WebGPU the pick readback goes through
  `copyTextureToBuffer`; the row order is handled by the `flipY` branch, but a
  first run on WebGPU should check one pick against a known object.
- **Pause and the tf cache.** The Time panel's Pause freezes the tf snapshot at
  the paused ROS time (`tf_time`). The worker's tf buffer keeps 10 s, so after
  about 10 s of pause frames start to disappear (lookups at the frozen time fall
  out of the cache) until Pause is released. RViz behaves the same way with its
  own buffer; a fix would stop evicting while paused.
- **Camera display shares GPU data with a second renderer.** three.js clears an
  attribute's `updateRanges` after the first renderer uploads, so the Camera
  panel re-uploads whole point-cloud buffers each frame (measured 1.6 ms for the
  mock scene; grows with cloud size). Rendering the camera view with the main
  renderer into a render target and blitting to the panel would avoid it.
- **Select tool and 300k-point boxes.** A box over a dense cloud returns one hit
  per visible point; the Selection panel is virtualised, but the highlight boxes
  stop at 2,000 hits (`SelectionManager.MAX_HIGHLIGHTS`).
- **Image display:** only raw `sensor_msgs/Image` encodings
  (rgb8/rgba8/bgr8/bgra8/mono8/mono16/8UC1/8UC3/8UC4/16UC1/32FC1);
  compressed / image_transport is Tier 2.

## Checked against rviz lyrical (2026-10-09)

The Tier 1 details first implemented from memory were compared with the
`lyrical` sources (`rviz_default_plugins/src/.../{odometry,pose_covariance,range,
grid_cells,point,polygon,robot_model,robot,image,camera}`,
`rviz_rendering/.../covariance_visual.cpp`, `rviz_common/.../properties/
covariance_property.cpp`, the ortho/fps/orbit view controllers, the measure/
point/pose/select/focus tools, `time_panel.cpp`, `views_panel.cpp`,
`view_manager.cpp`) and corrected. Remaining deliberate differences:

- **GridCells tiles are square.** rviz draws `cell_width × cell_height` tiles;
  `CloudObject` has one size per cloud, so the larger of the two is used.
- **Image YUV encodings (`yuyv`, `uyvy`, `nv12`) are converted but untested
  against a real camera**; `bayer_*` is shown as raw grey like rviz.
- **RobotModel `Description File`** is a plain path string (rviz uses a file
  picker); files are fetched through `/api/mesh`, so they must live under a
  package share directory or a `--package-path` root.
- **Link trails (`Show Trail`)** are stored but not drawn.
- **Camera / Image `Transport Override`** is stored but has no effect
  (image_transport is Tier 2).
