# Build troubleshooting

## Workspace fails to load: `default-features = false` cannot override workspace's `default-features`

**Seen:** 2026-10-08, after moving the repo to a new machine
(aarch64 Linux, Jetson / kernel 6.8 tegra, rustc 1.98.1, cargo 1.98.1).
The same tree built fine on the previous machine with an older toolchain.

### Symptom

Every cargo command (`cargo build`, `cargo check`, `cargo metadata`, `make build`,
`wasm-pack build`) fails before compiling anything:

```
error: failed to load manifest for workspace member `.../crates/wasm`
referenced via `crates/*` by workspace at `.../Cargo.toml`

Caused by:
  failed to parse manifest at `.../crates/wasm/Cargo.toml`

Caused by:
  error inheriting `serde_json` from workspace root manifest's `workspace.dependencies.serde_json`

Caused by:
  `default-features = false` cannot override workspace's `default-features`
```

A failed attempt may also leave `Cargo.lock` modified (the `serde_json` entry
dropped from `webrvizlite-wasm`). That is a side effect, not the cause;
`git checkout Cargo.lock` restores it.

### Cause

`crates/wasm/Cargo.toml` inherited `serde_json` from the workspace and tried to
switch its default features off:

```toml
# root Cargo.toml (before)
serde_json = "1"                                   # default features ON

# crates/wasm/Cargo.toml (before)
serde_json = { workspace = true, default-features = false, features = ["alloc"] }
```

Cargo does not allow a workspace member to *disable* default features that the
`[workspace.dependencies]` entry leaves enabled. Older cargo versions only
printed a warning:

```
warning: `default-features` is ignored for serde_json, since `default-features`
was true for `workspace.dependencies.serde_json`, this could become a hard error
in the future
```

and silently kept the default features, so the project built. Cargo 1.98 turned
that warning into a hard error, which is why the move to a machine with a
newer toolchain broke the build.

### Fix applied

Define the dependency in its minimal form at the workspace level and let each
crate opt in to the features it needs. This is the same pattern the root
already uses for `serde` and `thiserror`.

| File | Line |
| --- | --- |
| `Cargo.toml` | `serde_json = { version = "1", default-features = false }` |
| `crates/wasm/Cargo.toml` | `serde_json = { workspace = true, features = ["alloc"] }` |
| `crates/core/Cargo.toml` | `serde_json = { workspace = true, optional = true, features = ["std"] }` |
| `crates/bridge/Cargo.toml` | `serde_json = { workspace = true, features = ["std"] }` |
| `crates/server/Cargo.toml` | `serde_json = { workspace = true, features = ["std"] }` |

No source changes. Feature unification gives the wasm32 build `alloc` only and
the host build `std` (via core's `std` feature, bridge, and server).
`Cargo.lock` is unchanged because the dependency graph is the same.

### Rule for future dependencies

When a crate needs a workspace dependency *without* its defaults, declare the
workspace entry with `default-features = false` and add features per crate.
Never write `default-features = false` next to `workspace = true`.

### Verify

```sh
cargo metadata --locked --format-version 1 >/dev/null   # manifests parse, lock consistent
cargo check --workspace
cargo check -p webrvizlite-wasm --target wasm32-unknown-unknown
cargo test --workspace
make build                                               # wasm-pack → vite → cargo --release
./target/release/webrvizlite --mock --port 8765
```

### Environment checklist for a fresh machine

`make build` (mock transport, no ROS) needs:

- Rust stable with `rustup target add wasm32-unknown-unknown`
- `wasm-pack` (the Makefile installs it with `cargo install wasm-pack --locked` if missing)
- Node ≥ 22 and npm (`cd web && npm ci` runs inside `make web`)
- network access to crates.io and the npm registry on the first build

The `r2r` feature (real ROS 2) additionally needs a sourced ROS 2 Humble
environment; use the `docker/` container for that (`make docker-build-ros`).
