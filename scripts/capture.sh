#!/usr/bin/env bash
# Start the bridge and the capture proxy side-by-side for a dev session.
# Uses ports 3000 (bridge) and 8888 (capture proxy forwarding to :3000).
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BRIDGE_DIR"

echo "== starting gemini bridge on :3000 =="
node src/server.js > capture-logs/bridge.log 2>&1 &
BRIDGE_PID=$!
echo "bridge pid=$BRIDGE_PID"

sleep 2

# confirm bridge is up
if ! curl -s http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "ERROR: bridge did not become healthy on :3000"
  echo "--- bridge.log ---"
  cat capture-logs/bridge.log
  kill "$BRIDGE_PID" 2>/dev/null || true
  exit 1
fi

echo "== starting capture proxy on :8888 -> :3000 =="
node src/capture-proxy.js > capture-logs/capture.log 2>&1 &
CAPTURE_PID=$!
echo "capture pid=$CAPTURE_PID"

sleep 1

if ! curl -s http://127.0.0.1:8888/health >/dev/null 2>&1; then
  echo "WARNING: capture proxy did not respond on :8888 (non-fatal; it only proxies)"
fi

echo
echo "== running =="
echo "  bridge     : http://127.0.0.1:3000   (pid $BRIDGE_PID)"
echo "  capture    : http://127.0.0.1:8888   (pid $CAPTURE_PID)"
echo "  logdir     : $(pwd)/capture-logs"
echo
echo "Set your Android emulator HTTP proxy to 127.0.0.1:8888, then use the app."
echo "Press Ctrl+C to stop both."
echo

trap 'echo "stopping..."; kill "$BRIDGE_PID" "$CAPTURE_PID" 2>/dev/null || true; wait 2>/dev/null || true; echo "stopped"' INT TERM

# Wait for either process to exit
wait "$BRIDGE_PID" 2>/dev/null || true
wait "$CAPTURE_PID" 2>/dev/null || true
