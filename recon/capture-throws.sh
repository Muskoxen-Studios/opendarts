#!/usr/bin/env bash
# Capture a real throw sequence from the Board Manager.
# Starts detection, records the /api/events websocket, restores prior state on exit.
# Usage: ./recon/capture-throws.sh [board-ip] [port]
set -uo pipefail
HOST="${1:-192.168.120.40}"; PORT="${2:-3180}"
BASE="http://${HOST}:${PORT}"

was_running=$(curl -sS -m 5 "$BASE/api/state" | jq -r '.running // false')
echo "current state: $(curl -sS -m 5 "$BASE/api/state")"

cleanup() {
  echo
  if [ "$was_running" != "true" ]; then
    echo "restoring: detection was stopped before we started -> PUT /api/stop"
    curl -sS -m 5 -X PUT "$BASE/api/stop" -o /dev/null -w '  stop -> HTTP %{http_code}\n'
  else
    echo "leaving detection running (it was already running before)"
  fi
}
trap cleanup EXIT INT TERM

if [ "$was_running" != "true" ]; then
  echo "starting detection: PUT /api/start"
  curl -sS -m 10 -X PUT "$BASE/api/start" -o /dev/null -w '  start -> HTTP %{http_code}\n'
  sleep 2
  echo "state now: $(curl -sS -m 5 "$BASE/api/state")"
fi

echo
echo "=============================================="
echo " THROW 3 DARTS, THEN PULL THEM OUT."
echo " Ctrl-C when done."
echo "=============================================="
echo
node "$(dirname "$0")/listen.mjs" "ws://${HOST}:${PORT}/api/events"
