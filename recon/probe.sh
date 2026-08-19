#!/usr/bin/env bash
# Board Manager recon probe. Read-only: GETs + HEADs only, no state changes.
# Usage: ./recon/probe.sh <board-ip> [port]
set -uo pipefail

HOST="${1:?usage: probe.sh <board-ip> [port]}"
PORT="${2:-3180}"
BASE="http://${HOST}:${PORT}"
OUT="$(dirname "$0")/captures"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$OUT/probe-$STAMP.txt"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }

say "=== Board Manager probe $BASE @ $STAMP ==="

say ""
say "--- reachability ---"
curl -sS -m 5 -o /dev/null -w 'root: HTTP %{http_code}  %{content_type}  %{size_download}B  %{time_total}s\n' "$BASE/" 2>&1 | tee -a "$LOG"

say ""
say "--- root response headers ---"
curl -sS -m 5 -D - -o /dev/null "$BASE/" 2>&1 | tee -a "$LOG"

say ""
say "--- root body (first 60 lines) ---"
curl -sS -m 5 "$BASE/" 2>/dev/null | head -60 | tee -a "$LOG"

# Save the served frontend so we can mine it for endpoints.
say ""
say "--- fetching served UI assets ---"
ASSETDIR="$OUT/ui-$STAMP"
mkdir -p "$ASSETDIR"
curl -sS -m 10 "$BASE/" -o "$ASSETDIR/index.html" 2>/dev/null
# pull every js/css/wasm asset referenced by index.html
grep -oE '(src|href)="[^"]+"' "$ASSETDIR/index.html" 2>/dev/null \
  | sed -E 's/^(src|href)="//; s/"$//' \
  | grep -iE '\.(js|mjs|css|wasm)(\?|$)' \
  | sort -u \
  | while read -r a; do
      case "$a" in
        http*) url="$a" ;;
        /*)    url="$BASE$a" ;;
        *)     url="$BASE/$a" ;;
      esac
      fn="$(printf '%s' "$a" | tr '/?&=' '____' | tail -c 120)"
      if curl -sS -m 20 "$url" -o "$ASSETDIR/$fn" 2>/dev/null; then
        say "  saved $url -> $fn ($(wc -c < "$ASSETDIR/$fn") B)"
      else
        say "  FAILED $url"
      fi
    done

say ""
say "--- endpoint-ish strings mined from UI assets ---"
if [ -n "$(ls -A "$ASSETDIR" 2>/dev/null)" ]; then
  cat "$ASSETDIR"/* 2>/dev/null \
    | grep -aoE '(wss?://[A-Za-z0-9_./:{}$%~-]+|"/[A-Za-z0-9_./-]{2,80}"|/api/[A-Za-z0-9_./{}-]+|EventSource|WebSocket|text/event-stream|socket\.io|/events?\b|/ws\b)' \
    | sed 's/^"//; s/"$//' \
    | sort | uniq -c | sort -rn | head -80 | tee -a "$LOG"
else
  say "  (no assets retrieved)"
fi

say ""
say "--- candidate endpoint sweep (status / type / size) ---"
PATHS=(
  /api /api/ /api/detection /api/detections /api/board /api/boards /api/state
  /api/status /api/config /api/version /api/info /api/events /api/throws
  /api/cameras /api/cam /api/health /api/detection/state
  /detection /detection/state /state /status /config /version /info /health
  /events /throws /board /boards /metrics /openapi.json /swagger.json
  /swagger/index.html /docs /redoc /.well-known/openapi
)
for p in "${PATHS[@]}"; do
  read -r code ctype size < <(curl -sS -m 4 -o /dev/null \
      -w '%{http_code} %{content_type} %{size_download}\n' "$BASE$p" 2>/dev/null)
  [ -z "${code:-}" ] && code=ERR
  case "$code" in
    200|201|204|30*|401|403) say "  HIT  $code  ${ctype:-?}  ${size:-0}B  $p" ;;
    ERR)                     say "  err  ---                       $p" ;;
    *)                       : ;;  # 404/405/etc: quiet
  esac
done

say ""
say "--- bodies of 200-OK JSON endpoints ---"
for p in "${PATHS[@]}"; do
  ct="$(curl -sS -m 4 -o /dev/null -w '%{content_type}' "$BASE$p" 2>/dev/null)"
  case "$ct" in
    *json*)
      say ""
      say "### $p"
      curl -sS -m 4 "$BASE$p" 2>/dev/null | head -c 4000 | tee -a "$LOG"
      say ""
      ;;
  esac
done

say ""
say "--- SSE probe (does any path stream text/event-stream?) ---"
for p in /api/events /events /api/detection/events /api/stream /stream; do
  ct="$(curl -sS -m 3 -o /dev/null -w '%{content_type}' -H 'Accept: text/event-stream' "$BASE$p" 2>/dev/null)"
  [ -n "$ct" ] && say "  $p -> ${ct:-<none>}"
done

say ""
say "--- websocket upgrade probe ---"
for p in / /ws /api/ws /api/events /events /socket.io/?EIO=4\&transport=polling; do
  code="$(curl -sS -m 4 -o /dev/null -w '%{http_code}' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$BASE$p" 2>/dev/null)"
  say "  $p -> HTTP ${code:-ERR}   (101 = websocket accepted)"
done

say ""
say "=== done. full log: $LOG ==="
