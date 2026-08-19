#!/usr/bin/env bash
# Distinguish real local Board Manager endpoints from the cloud-proxied SPA fallback.
# A locally-served response has NO Cf-Ray header. Read-only (GET).
BASE="http://${1:-192.168.120.40}:${2:-3180}"
probe() {
  local p="$1"
  local hdrs; hdrs="$(curl -sS -m 4 -D - -o /dev/null "$BASE$p" 2>/dev/null)"
  [ -z "$hdrs" ] && return
  local code; code="$(printf '%s' "$hdrs" | head -1 | awk '{print $2}')"
  if printf '%s' "$hdrs" | grep -qi '^Cf-Ray:'; then return; fi   # cloud fallback, ignore
  local ct; ct="$(printf '%s' "$hdrs" | grep -i '^Content-Type:' | head -1 | cut -d' ' -f2- | tr -d '\r')"
  local body; body="$(curl -sS -m 4 "$BASE$p" 2>/dev/null | head -c 300 | tr '\n' ' ')"
  printf 'LOCAL  %s  %-26s  %-34s  %s\n' "$code" "${ct:-?}" "$p" "$body"
}
for p in \
  /api /api/state /api/config /api/version /api/events /api/status /api/detection \
  /api/detection/state /api/detection/start /api/detection/stop /api/start /api/stop \
  /api/cams /api/cams/stats /api/cam /api/cameras /api/streams /api/streams/cams \
  /api/streams/cams/0 /api/streams/cams/1 /api/streams/cams/2 /api/streams/cams/3 \
  /api/calibration /api/config/calibration /api/config/distortion \
  /api/config/calibration/ellipses /api/board /api/boards /api/throws /api/turn \
  /api/motion /api/state/motion /api/state/stats /api/stats /api/health /api/info \
  /api/log /api/logs /api/debug /api/metrics /api/reset /api/restart /api/refresh \
  /api/upstream /api/upstream/connect /api/upstream/status /api/auth /api/token \
  /api/system /api/settings /api/update /api/updates /api/license /api/ping \
  ; do probe "$p"; done
