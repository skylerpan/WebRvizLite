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
