# Running troubleshooting

Problems hit when starting the server, with cause and fix. Build-time problems
are in [`build-troubleshooting.md`](build-troubleshooting.md).

## Browser on another machine cannot connect

**Symptom:** the server logs `listening on http://127.0.0.1:8765/`, `curl` on the
host works, but a browser on another machine gets connection refused.

**Cause:** `--bind` defaults to `127.0.0.1`.

**Fix:** start with `--bind 0.0.0.0` (or the host's LAN address). The same
applies to the Vite dev server used by `make dev`: run
`cd web && npm run dev -- --host` for remote access.

## Host without ROS 2: only `--mock` works

**Symptom:** `./target/release/webrvizlite` without `--mock` fails to start, or
`cargo build --features r2r` fails to resolve ROS message types.

**Cause:** the default host build has no ROS transport; the `r2r` feature needs
a sourced ROS 2 environment at build time.

**Fix:** on the host use `--mock` (synthetic `/scan`, `/tf`, `/tf_static`,
`/clock`; `-d fixtures/mock_scene.rviz` for the full Tier 0 scene). For real
ROS 2 build and run inside the container: `make docker-build-ros`,
`make docker-run-ros`. The bridge can only subscribe to packages that are
installed in the image (`docker/Dockerfile`) and listed in
`IDL_PACKAGE_FILTER` (`docker/compose.yml`).

## Costmap only refreshes when the robot moves

**Symptom:** a Map display on a Nav2 costmap (`.../local_costmap/costmap`)
shows a new grid only when the robot moves; obstacles appearing while it is
stationary never show up. The browser console has
`[bridge] sub N: unknown message type: map_msgs/msg/OccupancyGridUpdate`, the
server log `subscribe failed ... type_name=map_msgs/msg/OccupancyGridUpdate`,
and the display status shows `Update Topic: unknown message type ...`.

**Cause:** Nav2's `always_send_full_costmap` defaults to `false`: the full
`OccupancyGrid` is published only when the grid's origin or size changes (for a
rolling local costmap, when the robot moves). Everything else goes out as
`map_msgs/OccupancyGridUpdate` patches on `<topic>_updates`, which the Map
display subscribes to automatically. That subscription fails when the bridge
was built without `map_msgs` typesupport (the package is not part of
`ros-base`; it is installed by `docker/Dockerfile`).

**Fix:** rebuild the image and the bridge so r2r generates the `map_msgs`
bindings:

```sh
make docker-build
docker compose -f docker/compose.yml run --rm dev cargo clean --release -p r2r_msg_gen -p r2r
make docker-build-ros
```

Then `ros2 topic info -v <topic>_updates` should list a `webrvizlite`
subscriber. Alternatively set `always_send_full_costmap: true` on the Nav2
costmap nodes, at the cost of sending the whole grid every cycle.

## Container server port: README says 8766, Makefile uses 8765

**Symptom:** `make docker-run-ros` binds 8765, not 8766 as the README states.
Running it while the host mock server is up fails with address in use.

**Cause:** the Makefile target passes `--port 8765`; the README is out of date.

**Fix:** stop the other server first, or change `--port` on one side.
Treat the Makefile as authoritative.

## Frontend changes do not show up after rebuilding only the web part

**Symptom:** `web/dist` is newer than the binary and the browser still shows the
old UI.

**Cause:** the frontend is embedded into the server binary at compile time
(`rust-embed`, `crates/server/static_files.rs`). `npm run build` alone does not
update the binary.

**Fix:** run `make build` (or `make server`; `crates/server/build.rs` has
`rerun-if-changed=../../web/dist`, so cargo re-embeds). To check whether a
binary is stale, compare the hashed asset names:

```sh
strings target/release/webrvizlite | grep -o 'index-[A-Za-z0-9_-]*\.js'
ls web/dist/assets
```

For development use `--web-dir web/dist` (what `make dev` does) so the binary
serves the directory instead of the embedded copy.
