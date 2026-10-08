# WebRvizLite build entry points. `make build` produces a single executable
# (target/release/webrvizlite) with the frontend embedded.

SHELL := /bin/bash
.DEFAULT_GOAL := build

WASM_OUT := web/src/wasm/pkg
COMPOSE  := docker compose -f docker/compose.yml

# cargo / wasm-pack output dir. Override when target/ is unusable on the host
# (e.g. `make CARGO_TARGET_DIR=target-host mock-rust`).
CARGO_TARGET_DIR ?= target
export CARGO_TARGET_DIR
MOCK_PORT ?= 8765

.PHONY: build wasm web server server-ros dev test check clean docker-build docker-shell docker-build-all docker-build-ros docker-run-ros docker-run-rosd mock-rust docker-mock-ros

build: wasm web server

wasm: $(WASM_OUT)/webrvizlite.js

$(WASM_OUT)/webrvizlite.js: $(shell find crates/core crates/wasm -name '*.rs' -o -name 'Cargo.toml') Cargo.toml
	@command -v wasm-pack >/dev/null || cargo install wasm-pack --locked
	wasm-pack build crates/wasm --target web --release --out-dir ../../$(WASM_OUT) --out-name webrvizlite

web/node_modules/.package-lock.json: web/package.json web/package-lock.json
	cd web && npm ci

web: wasm web/node_modules/.package-lock.json
	cd web && npm run build

# Host build: mock transport only (no ROS 2 needed). Run with `--mock`.
server:
	cargo build --release -p webrvizlite-server

# ROS 2 build: needs a sourced ROS 2 environment (use the container).
server-ros:
	cargo build --release -p webrvizlite-server --features r2r

# Vite dev server (HMR, port 5173, proxies /ws to the Rust server) + Rust server.
dev: wasm web/node_modules/.package-lock.json
	@trap 'kill 0' EXIT; \
	cargo run -p webrvizlite-server -- --web-dir web/dist & \
	cd web && npm run dev

test:
	cargo test --workspace
	cd web && npm test

check:
	cargo clippy --workspace --all-targets -- -D warnings
	cargo fmt --all -- --check
	cd web && npm run typecheck

clean:
	cargo clean
	rm -rf web/dist $(WASM_OUT)

# ---- Docker (ROS 2 Humble toolchain; required once the bridge links r2r) ----
docker-build:
	$(COMPOSE) build

docker-shell:
	$(COMPOSE) run --rm dev bash

docker-build-all:
	$(COMPOSE) run --rm dev make build

# Full build with real ROS 2 support, inside the container.
docker-build-ros:
	$(COMPOSE) run --rm dev make wasm web server-ros

# Run the ROS-enabled server from the container (host network → http://127.0.0.1:8766,
# leaving 8765 free for the host `--mock` server).
# DDS config: conf/cyclonedds.xml via CYCLONEDDS_URI (see docker/compose.yml).
docker-run-ros:
	$(COMPOSE) run --rm dev ./$(CARGO_TARGET_DIR)/release/webrvizlite --bind 0.0.0.0 --port 8766 -d fixtures/mock_scene.rviz

# Run the ROS-enabled server from the container (host network → http://127.0.0.1:8766,
# leaving 8765 free for the host `--mock` server).
# DDS config: conf/cyclonedds.xml via CYCLONEDDS_URI (see docker/compose.yml).
docker-run-rosd:
	$(COMPOSE) run -d --rm dev ./$(CARGO_TARGET_DIR)/release/webrvizlite --bind 0.0.0.0 --port 8766

# ---- Mock scenes (two different mocks) ----
# mock-rust:       the server's own Rust MockTransport (crates/bridge/src/mock.rs).
#                  Runs on the host, no ROS 2 needed: the server generates the
#                  full-scale scene itself and streams it straight to the browser;
#                  nothing is published on ROS (`ros2 topic list` shows nothing).
#                  For frontend / perf work. Rebuilds first so the embedded
#                  frontend is never stale.       -> http://127.0.0.1:$(MOCK_PORT)
# docker-mock-ros: rclpy node in the container (tools/mock_scene.py) publishing
#                  the same scene (reduced sizes) on real ROS 2 topics, to
#                  exercise the r2r bridge. Run `make docker-run-ros` in another
#                  terminal.                      -> http://127.0.0.1:8766
mock-rust: build
	./$(CARGO_TARGET_DIR)/release/webrvizlite --mock --port $(MOCK_PORT) -d fixtures/mock_scene.rviz

docker-mock-ros:
	$(COMPOSE) run --rm dev python3 tools/mock_scene.py
