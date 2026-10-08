# WebRvizLite

ROS 2 visualization in the browser, modelled on RViz 2 (lyrical, rviz2 15.2.6):
same panels, property names, defaults and `.rviz` config format. Rendering is
three.js (WebGPU with WebGL2 fallback) and only chases performance.

## Layout

| Path | What |
| --- | --- |
| `crates/core` | Shared no_std-friendly core: wire protocol, CDR decoding, tf2 buffer, point cloud transforms |
| `crates/wasm` | wasm-bindgen wrapper of `core` for the Web Worker |
| `crates/bridge` | ROS 2 transport trait + r2r implementation |
| `crates/server` | axum server: WebSocket bridge + embedded frontend, one executable |
| `web/` | Vite + SolidJS + three.js + dockview frontend |
| `fixtures/` | Test `.rviz` files, CDR samples |
| `docker/` | ROS 2 Humble build/dev container |

## Build

Prerequisites: Rust stable with the `wasm32-unknown-unknown` target, Node ≥ 22,
and (from M1 on) a sourced ROS 2 environment for the r2r bridge.

```sh
make build            # wasm-pack → vite build → cargo build --release (mock transport only)
./target/release/webrvizlite --mock --port 8765
```

Build fails to load the workspace on a newer cargo? See
[`docs/build-troubleshooting.md`](docs/build-troubleshooting.md).
Server starts but the browser cannot connect, or the UI is stale? See
[`docs/running.md`](docs/running.md).

Open <http://127.0.0.1:8765>. `--mock` serves a synthetic scene (`/scan` 10 Hz,
`/livox/lidar` 10 Hz, `/tf` 30 Hz, `/tf_static`, `/clock`) and needs no ROS. Append `?debug` to open
the topic debug panel (graph, subscribe toggles, receive rates), `?webgl` to
force the WebGL2 backend.

Real ROS 2 support is the `r2r` cargo feature and must be built inside a
sourced ROS 2 environment (see Docker below):

```sh
cargo build --release -p webrvizlite-server --features r2r
./target/release/webrvizlite --port 8765 --ros-args -p use_sim_time:=true
```

Development with HMR:

```sh
make dev              # Rust server on :8765 + Vite dev server on :5173 (proxies /ws)
```

### Without ROS 2 on the host

```sh
make docker-build     # builds webrvizlite-dev (ros:humble-ros-base + Rust + Node)
make docker-shell     # interactive shell with ROS sourced, repo mounted at /ws
make docker-build-ros # wasm + web + cargo --features r2r, inside the container
make docker-run-ros   # ROS-enabled server on http://127.0.0.1:8766 (host network)
make docker-mock-scene # rclpy publisher of the same synthetic scene, for testing
```

The container uses host networking so DDS discovery works against the robot's
graph. Set `ROS_DOMAIN_ID` in the environment if needed. r2r resolves message
typesupport at build time: the bridge can only subscribe to types whose package
is both installed in the image (`docker/Dockerfile`; `ros-base` lacks e.g.
`map_msgs`) and listed in `IDL_PACKAGE_FILTER` (`docker/compose.yml`). After
adding a package, clear r2r's generated bindings before rebuilding:
`docker compose -f docker/compose.yml run --rm dev cargo clean --release -p r2r_msg_gen -p r2r`.
`livox_ros_driver2/msg/CustomMsg` (Livox native point clouds, `xfer_format: 1`)
is covered by a message-only copy of the upstream package in `docker/livox_msgs`
that the image builds into `/opt/livox_ws`; the display class is
`webrvizlite/LivoxCustomMsg` (reflectivity → `intensity`, plus `tag`, `line`,
`offset_time` channels).

## Protocol

One WebSocket per browser tab at `/ws`. Binary frames carry raw CDR:
`u8 kind | u32 subscription_id | u64 receive_time_ns | payload` (little-endian).
Text frames are JSON control messages with an `op` field; the types live in
`crates/core/src/protocol.rs` and are shared by the server and the WASM worker.
The server keeps one ROS subscription per distinct `(topic, type, qos)` and
applies per-client backpressure: best effort keeps only the newest frame,
reliable keeps at most `depth` frames.

## CLI

```
webrvizlite [-d config.rviz] [-f FRAME] [-t FORMAT] [-s IMAGE] [--bind ADDR] [--port N] [--web-dir DIR]
```

`--web-dir` serves the frontend from a directory instead of the embedded build;
`--mock` uses the built-in synthetic transport. Anything after `--ros-args` is
passed to rcl.

## Shortcuts

Chrome reserves Ctrl+N / Ctrl+T / Ctrl+W, so a few RViz bindings differ
(`web/src/app/shortcuts.ts` is the single table; Help → About lists it too).

| Action | WebRvizLite | RViz |
| --- | --- | --- |
| Open / Save / Save As | Ctrl+O / Ctrl+S / Ctrl+Shift+S | same |
| Add Display | Ctrl+Alt+N | Ctrl+N |
| Duplicate / Remove / Rename Display (Displays tree focused) | Ctrl+D / Delete (Ctrl+X) / F2 | Ctrl+D / Ctrl+X / Ctrl+R |
| Tools (3D view focused) | i m s c n p g u, Esc = default tool | same |
| Reset view | Z | Z |
| Fullscreen | F11 | F11 |

Save writes back where the config came from: the `-d` file through the
server, a file opened with the File System Access API in place, otherwise a
download. Recent configs are kept in localStorage (file handles in IndexedDB).

## Mock scene

`fixtures/mock_scene.rviz` with `--mock` shows every Tier 0 display: a map
with the three colour schemes, a path with pose arrows, goal pose, particle
cloud, laser scan, a 300k-point PointCloud2 at 10 Hz, a 24k-point Livox
CustomMsg rosette scan, and a MarkerArray with
every marker type plus 5,000 cubes. `?perf` adds frame-time counters to the
status bar; `?debug` opens the topic panel.

## Tests

```sh
make test             # cargo test --workspace && vitest
make check            # clippy -D warnings, rustfmt, tsc
```
