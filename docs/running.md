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
`make docker-run-ros`. The bridge can only subscribe to packages listed in
`IDL_PACKAGE_FILTER` (`docker/compose.yml`).

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
