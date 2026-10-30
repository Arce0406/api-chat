#!/usr/bin/env bash
# 在 docker 裡編譯並測試桌面版的 Rust 部分（開發機不用裝 Rust 與系統套件）。
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=api-chat-tauri-linux
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/api-chat-cargo"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" -f scripts/docker/tauri-linux.Dockerfile scripts/docker
[ -f dist/index.html ] || npm run build
mkdir -p "$CACHE/registry" "$CACHE/target"
docker run --rm -u "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/target \
  -v "$CACHE/registry":/cargo/registry -v "$CACHE/target":/target \
  -v "$PWD":/work -w /work/src-tauri \
  "$IMAGE" cargo test --locked "$@"
