#!/usr/bin/env bash
# 啟動開發伺服器，用 Playwright 官方 docker 映像跑端對端測試，結束後關掉伺服器。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=5310
IMAGE="mcr.microsoft.com/playwright:v1.56.1-noble"

if ss -ltn | grep -q ":${PORT} "; then
  echo "port ${PORT} 已被占用，請先關掉占用的程式" >&2
  exit 1
fi

node_modules/.bin/vite --port "$PORT" --strictPort >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${PORT}/" >/dev/null && break
  sleep 0.2
done

docker run --rm --network host --ipc=host \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e E2E_REAL -e REAL_API_KEY \
  -v "$PWD":/work -w /work \
  "$IMAGE" npx playwright test "$@"
