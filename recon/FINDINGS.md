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

## 3. Throw payload — CONFIRMED

Captured 2026-08-20 against the real board (`recon/captures/live-ws-2026-08-20T10-06-03-291Z.ndjson`),
three darts thrown then taken out. Real `state` frame on the third dart:

```json
{
  "connected": true, "running": true,
  "status": "Takeout", "event": "Throw detected", "numThrows": 3,
  "throws": [
    { "segment": { "name": "S11", "number": 11, "bed": "SingleInner", "multiplier": 1 },
      "coords": { "x": -0.24093133012437515, "y": 0.006307790868472802 } },
    { "segment": { "name": "S4", "number": 4, "bed": "SingleOuter", "multiplier": 1 },
      "coords": { "x": 0.5476268779047749, "y": 0.33845423262136143 } },
    { "segment": { "name": "S1", "number": 1, "bed": "SingleInner", "multiplier": 1 },
      "coords": { "x": 0.18832737995641766, "y": 0.37901887299768106 } }
  ]
}
```

The UI's board renderer does:

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
`segment.name`: `"D20"`, `"M20"` (miss ring), etc. — a 1-char prefix + number.

`packages/fakeboard` **emitted almost exactly this inferred shape** ahead of the
real capture — `toRawCoords`'s `{x, y}` / normalised-by-170 / bull-origin
formula lands within noise of the real board's numbers for all three darts
above. Two guesses it got wrong: `multiplier` **is** present on the real segment
(`1` for singles here) — harmless, the adapter derives the ring from `bed` and
ignores it — and the **direction of the y axis**, which was not harmless. See
the correction below.

### Correction: y points UP, not down

This section originally read "y down (screen convention)", and both the fake
board and `toCoords` were built to match. It is wrong, and it mirrored every
board-sourced dart top-to-bottom: a dart at 20 plotted at 3, which is 20's
opposite segment.

**How it was missed.** The original check was that each captured dart landed at
the *predicted radius* for its segment. A radius is identical under either sign
of y, so that check could never have distinguished the two conventions — and
the one dart whose angle was quoted, S11, sits at 9 o'clock with `y ≈ 0.006`,
which is also sign-agnostic. Checking the *angles* of the other two settles it:

| dart | raw coords | bearing if y is up | its segment's true bearing |
|---|---|---|---|
| S11 | `(-0.2409, 0.0063)` | 268.5° | 270° (9 o'clock) — sign-agnostic |
| S4  | `(0.5476, 0.3385)`  | 58.3°  | 54° |
| S1  | `(0.1883, 0.3790)`  | 26.4°  | 18° |

(Bearings clockwise from 12 o'clock.) S4 and S1 both sit in the **upper** right
of the board and both were reported with **positive y**. Under "y down" they
would have to be in the lower right, 90°+ from their own wedge.

**Settled:**
- `coords`: `{x, y}`, normalised by 170 (board-mm / 170), origin at the bull,
  x right, **y up** — the same orientation as `@darts/schema`'s `Coords`, so
  `toCoords` only scales and does not flip. Guarded by a round-trip test in
  `packages/bridge/src/adapters/autodarts.test.ts` that asserts every segment
  lands back inside its own wedge, i.e. by **angle**, not by radius.
- `segment` carries `number` and `multiplier` in addition to `name`/`bed`.
- `throws[]` is **cumulative for the visit**: it grew from 1 to 3 entries as
  each dart landed, each element's `segment`/`coords` staying fixed once set.
- `event` sequence: `"Throw detected"` per dart (status `"Throw"` while armed,
  `"Takeout"` once 3 are down); `"Takeout started"` while status is
  `"Takeout in progress"` (throws[] still populated); then `"Takeout finished"`
  with `numThrows: 0` and **no `throws` key at all** (not `throws: []`).

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

§3 is settled, including the y-axis correction above: `toCoords` in
`packages/bridge/src/adapters/autodarts.ts` scales by 170 and nothing else, and
`packages/fakeboard/src/payload.ts` emits the matching y-up formula.

The lesson worth keeping: **a radius cannot confirm an axis direction.** Any
future claim about the board's coordinate frame has to be checked by angle,
against a dart that is not on an axis.

The capture that settled it, `recon/captures/live-ws-2026-08-20T10-06-03-291Z.ndjson`,
is worth keeping as a `replay` fixture: it is a real three-dart-then-takeout
sequence, not a synthesised one.
