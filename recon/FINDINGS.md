# Autodarts Board Manager — local protocol (reverse-engineered)

Board: `192.168.120.40:3180` · Board Manager **v1.0.7** · board_id `c682ced4-…e7110`
Captured 2026-08-19. Evidence: `recon/captures/`.

## Status legend
- **CONFIRMED** — observed on the wire against this board.
- **FROM BUNDLE** — read out of the Board UI's minified JS. Names reliable, types not.
- **OPEN** — not yet established.

---

## 1. Transport — CONFIRMED

WebSocket: `ws://<board>:3180/api/events`

- Plain `GET` → `400 Bad Request`; websocket upgrade → `101`.
- **No auth, no subscribe frame.** Server pushes unsolicited on connect.
- Envelope: `{"type": "<channel>", "data": {...}}`
- Client dispatches on `type`, hands `data` to handlers. Reconnect in the stock UI
  is a flat 1 s retry.

### Channels and observed rates (45 s idle capture, detection running)

| channel | rate | notes |
|---|---|---|
| `motion_state` | **30/s** | per-cam motion; very chatty, must be throttled/dropped in the bridge |
| `cam_stats` | 3/s | `{id, fps, resolution}` |
| `stats` | 1/s | `{fps, resolution}` |
| `state` | **0 in 45 s** | edge-triggered only — fires on throw/takeout. **This is the one that matters.** |
| `cam_state` | not seen | subscribed by the UI; likely cam connect/disconnect |
| `calibration_state` | not seen | fires during calibration |

`state` being edge-triggered is the key design fact: the bridge must treat it as
an event stream, not a heartbeat, and must **not** infer liveness from it.
Use `stats` (1/s) as the liveness signal instead.

## 2. Control API — CONFIRMED

All under `/api`, unauthenticated (`auth.api_key` is empty in this board's config).

| method | path | effect |
|---|---|---|
| PUT | `/api/start` | start detection → `running:true, status:"Throw", event:"Started"` |
| PUT | `/api/stop` | stop detection |
| POST | `/api/reset` | reset throw counter |
| PUT | `/api/streams/start` · `/api/streams/stop` | camera streaming |
| POST | `/api/config/calibration/auto` | auto-calibrate |
| GET | `/api/state` | `{connected, running, status, event, numThrows, throws[]}` |
| GET | `/api/state/dump` | full dump |
| GET | `/api/state/motion` · `/api/state/stats` | motion / fps snapshot |
| GET | `/api/config` · `/api/config/calibration` · `/api/config/distortion` · `/api/config/calibration/ellipses` | config + geometry |
| GET | `/api/cams/stats` · `/api/version` · `/api/ping` | → `pong`, `1.0.7` |
| GET | `/api/streams/{live,motion,detection,detection/movement}` | MJPEG (`multipart/x-mixed-replace`) |
| GET | `/api/streams/cams/{0,1,2}` | per-cam MJPEG |
| GET | `/api/img/...` | single frame (UI swaps `streams`→`img` for stills) |

`status` enum: `Starting · Stopping · Stopped · Throw · Takeout · Takeout in progress · Calibrating · Offline · Setup · Error`
(`status:"Throw"` means *armed and waiting*, not "a dart just landed".)

## 3. Throw payload — FROM BUNDLE, NOT YET CONFIRMED

`state.data.throws` is an array. The UI's board renderer does:

```js
const coords   = (throws||[]).map(d => d.coords).filter(Boolean);
const segment  = throws[throws.length-1].segment;
switch (segment.bed) {
  case "SingleInner": return "SI" + segment.name.slice(1,5);
  case "SingleOuter": return "SO" + segment.name.slice(1,5);
}
return segment.name;
```

So each throw has **both** `coords` and `segment` — raw position *and* a resolved
segment. We get heatmaps/grouping for free without owning segment mapping.

`segment.bed` enum: `Single · SingleInner · SingleOuter · Double · Triple · Outside`
`segment.name`: `"D20"`, `"M20"` (miss ring), etc. — `slice(1,5)` implies a
1-char prefix + number.

**OPEN — needs a real throw to settle:**
- `coords` shape: `{x,y}` or `[x,y]`? units? origin? y-axis direction?
- Does `segment` also carry `number` / `multiplier`? (`multiplier` appears
  **0 times** in the bundle — so probably not; the bridge likely derives it from `bed`.)
- Is `throws[]` cumulative for the turn, or reset per dart?
- What `event` values accompany a throw vs. a takeout?

## 4. Cloud independence — CONFIRMED

| path | served by |
|---|---|
| `/api/*` | **the board, locally** — no Cloudflare headers |
| `/` and `/assets/*` | Autodarts CDN via Cloudflare (`Cf-Ray`, `Cf-Cache-Status`) |

The API is fully local. Only the stock UI *shell* is cloud-fetched — which is
why the stock board UI needs internet, and why our own frontend removes that
dependency entirely. No `api.autodarts.io` traffic observed from `/api/*`.

**Caveat:** the JS bundle mixes the board client with the *cloud* game-service
client (`/tournaments`, `/stripe`, `/lobbies`, `/matches`, `/users/me`). Those
are **not** board endpoints. Don't mine the bundle for board paths without
checking each against the board first.

### Recon method note
A real local endpoint returns **no `Cf-Ray` header**. Unknown paths fall through
to the cloud-proxied SPA `index.html` (200, 647 B, `text/html`) — so naive
"is it 200?" probing yields false positives on every path. Filter on `Cf-Ray`.

## 5. Board geometry (from bundle, standard BDO spec — usable for our frontend)

Radii in mm, normalized by 170: bull inner 7, bull outer 17, treble 97–107,
double 160–170, board 225. Segment angle 360/20.
Number order: `20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5`

## 6. This board's config
3 cameras (indices `["0","1","3"]`, addressed as 0/1/2 in the API), 1280×720 @ 30fps,
auto-calibrate on start enabled, motion standby 15 min.

---

## Next step
Capture a real throw: `./recon/capture-throws.sh 192.168.120.40`
(starts detection, records `/api/events`, restores prior state on Ctrl-C).
Throw 3 darts, pull them out, Ctrl-C. That settles every OPEN item in §3.
