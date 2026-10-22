# Native detector vertical slice

A Python 3 stdlib service, binding **only 127.0.0.1:8091** by default. This is an
image-based proof-of-pipeline, **not a production dart detector**. Synthetic and
replay sources retain their planar marker detector. The `rendered` source accepts
browser grayscale images and validated pinhole calibration, and reconstructs
perspective shaft axes using only those pixels. No numpy/OpenCV, live camera
acquisition, or automatic calibration is required or implemented. Bridge/proxy,
desktop lifecycle, and the browser renderer are separate concerns.

From the repository root:

```sh
python3 services/detector/main.py --source synthetic
# Browser-uploaded perspective cameras (waits for /render/configure):
python3 services/detector/main.py --source rendered
python3 -m unittest discover -s services/detector -p 'test_*.py'
# Two views instead of the default three:
python3 services/detector/main.py --source synthetic --cameras 2
# Deterministic, image-only replay (holds its last image after EOF):
python3 services/detector/main.py --source replay --replay testdata/vision/sequence.json
```

`--port` overrides 8091; the bind address cannot be widened. Detection starts
armed. Wait for `/state` status `Throw` and `pending.adoptingBaseline: false`
before sending the first simulated dart. Armed simulator throws during baseline
adoption, acquisition faults or review faults return 409 instead of being silently
swallowed. Stopped simulation remains allowed and is not scored. Ctrl-C shuts down
the service.

## Offline rendered evaluation and tuning

Render once, then run Python against cached pixels—no AI calls, cloud service, or
rerendering per trial. Generation needs installed Electron and, on Linux,
`xvfb-run` with working X11 access. Evaluation/tuning needs only Python stdlib.
From the repository root:

```sh
npm run detector:generate -- --small --output build/rendered-benchmark
npm run detector:evaluate -- build/rendered-benchmark/dataset.json --output build/rendered-benchmark/baseline.json
npm run detector:tune -- build/rendered-benchmark/dataset.json --output build/rendered-benchmark/tuning.json --trials 100 --seconds 1800 --seed 1
# Continue toward a total of 200 trials:
npm run detector:tune -- build/rendered-benchmark/dataset.json --output build/rendered-benchmark/tuning.json --trials 200 --seconds 1800 --seed 1 --resume
```

Omit `--small` for 66 cases rather than 33 (264 versus 132 steps). Ordinary
impacts have at least 10 mm scoring-boundary clearance; near-wire cases remain
explicitly difficult. Independent single-dart cases supplement sequences so one
latched fault does not conceal all later models. Cases cover perpendicular/tilted darts,
shallow supported angles, dimensions, clustered occlusion, near-wire impacts,
noise/exposure, frozen camera views, and sequential additions/removals. Images
come from the actual Three.js meshes and cameras, not analytic line fixtures.
Exposure/noise variants are sensor-level transformations. Current dart validation
limits tilt to 45° per axis; this is not an exhaustive near-parallel-angle suite.
Generation is seeded and hash-cached; use a new output directory for a new corpus.
Scenario/cache version 4 changes pixels: 1280×720, an explicit provisional
100° horizontal baseline (about 67.67° vertical) replacing custom 95° vertical rigs.
Cache provenance records resolution, FOV, grayscale orientation and the provisional
calibration status; benchmark mounts remain varied per case. 8 mm axial point penetration is explicit,
board-entry `(x,y,0)` labels are unchanged, and board number labels are excluded
from detector cameras. Raised wires already existed and now share geometry with
an optional conservative browser placement filter. Offline scenarios intentionally
remain unrestricted (including near-wire overlaps); no bounce physics is modeled.
Version-2/3 caches/results and previously tuned parameters are historical, not evidence
for this rendering: regenerate into a new directory and reevaluate before reuse.
Do not automatically generate datasets, resume old tuning, or promote parameters.
The geometry is representative rather than a physical-accuracy claim.

`dataset.json` holds labels and split assignments separately from calibration and
image JSON files. The detector receives only calibration and synchronized pixels.
Entire scenario families stay in one split. Tuning uses **train** for search,
**validation** for selection, and never evaluates **test**. After at least eight
exploration trials it refines around the safety-ranked best training candidate
only if that candidate has positive nonempty coverage. Otherwise broader coupled
parameter exploration continues, including a full bounded draw every fourth trial. Checkpoints include RNG
state, dataset-content hash, implementation fingerprint, and trial reports; code,
data, seed, or shortlist changes intentionally invalidate resume. The time budget
is soft: an in-flight evaluation finishes before stopping.

Reports distinguish required misses, allowed safe rejection, wrong acceptance,
localization error, phantom/duplicate/removal errors, and runtime. Selection is
lexicographic: invariant-safe candidates first, fewer wrong accepts next, then
correct required nonempty occupancy coverage and localization. Empty successes
do not earn tuning coverage; reject-all is explicitly reported and earns zero
impact coverage. A safe reject-all candidate can still beat an unsafe one—such a
result is a detector limitation, not successful tuning or measured confidence.
Evaluation also reports `uncertaintyCalibration`: coordinate error comparisons,
errors outside the reported bound, unmatched occupancy, maximum error, and maximum
error/bound ratio. It includes scoring-boundary rejections after acquisition and
occupancy reconciliation succeed; ambiguous or unresolved occupancy is excluded.
Comparisons include previously accepted/repeated darts, so they are not independent
samples or statistical confidence estimates. Labels remain offline evaluation data.
Always read these counts alongside rejection coverage and safety errors: an empty
audit or a reject-all result cannot establish a useful uncertainty model.
Each step requires three distinct uploads; reset-required faults stay latched.
After an unresolved image/occupancy rejection, the perspective detector requires
three stable empty-board uploads before accepting a new nonempty scene. This
prevents several accumulated darts from being scored as one; transient acquisition
ambiguity may therefore require clearing the board. Partial removal also rejects
newly occupied background pixels, which can represent occlusion or revealed darts.
Uncertainty-aware scoring and protocol/occupancy safety rules are not tunable.
The shaft envelope measures axial length (not board-normal height); its 217 mm
default covers the renderer's maximum supported dart extent without enlarging
flight radius or weakening ambiguity checks.

The baseline always joins validation finalists, and completed validation results
are retained across resume. Selection requires positive nonempty coverage and zero
wrong acceptances, phantom/duplicate detections, and removal errors. Checkpoint
`status` is `validation_pending`, `selected`, or `no_acceptable_candidate`, with an
explanatory `reason`; an unsafe finalist never becomes a selected candidate merely
because it ranks highest. This is a minimum gate, not a production readiness claim.

**No automatic promotion.** Inspect the selected candidate and per-case reports.
Export its plain parameter object, then evaluate the untouched test split:

```sh
python3 -c "import json; t=json.load(open('build/rendered-benchmark/tuning.json')); assert t['selected'] is not None; json.dump(t['selected']['parameters'], open('build/rendered-benchmark/candidate.json', 'w'), indent=2)"
npm run detector:evaluate -- build/rendered-benchmark/dataset.json --parameters build/rendered-benchmark/candidate.json --split test --output build/rendered-benchmark/held-out.json
# Explicit opt-in only, after review:
python3 services/detector/main.py --source rendered --parameters build/rendered-benchmark/candidate.json
```

The service accepts a validated plain (possibly partial) parameter object, not the
whole tuning artifact. Defaults remain active without `--parameters`. Bounds live
in `parameters.py`; they are search constraints, not an accuracy guarantee. Test
results on this simulated corpus do not establish real-camera reliability. Use
independent hardware recordings before promoting anything for actual play.
Generated images/reports live under ignored `build/`; they are reproducible local
artifacts, not bundled in the application.

## API

No authentication or CORS support; intended for local bridge/server access, not
remote exposure. JSON bodies are limited to 4096 bytes, except `/render/configure`
and `/render/frames`, which allow **6 MiB**. Successful POSTs return
HTTP 200 `{"ok":true}`. Invalid bodies return 400; unknown routes/cameras 404.
Duplicate JSON keys, non-finite numbers, invalid UTF-8, boolean coordinates,
non-integer/null takeout counts, and unsupported transfer encoding are rejected.
POST reads have a five-second socket timeout; rejected bodies close the connection.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/health` | `{"ok":true,"session":"..."}` (process liveness, not camera health) |
| GET | `/state` | Snapshot: `session`, `source`, `running`, schema-compatible `status`, `cameras`, integer `occupancy`, `pending`, `faults` |
| GET | `/events` | SSE `id: SESSION:COUNTER`, `data: BoardEvent JSON`, blank line separator |
| GET | `/cameras/cam0/frame` | Current grayscale PNG; also `cam1`, and `cam2` in three-camera mode. 503 if unavailable |
| POST | `/control/start` | Empty object/body; arm and adopt stable current occupancy |
| POST | `/control/stop` | Empty object/body; disarm, continue capture/health/occupancy tracking |
| POST | `/control/reset` | Empty object/body; adopt stable current occupancy, no physical image changes |
| POST | `/sim/throw` | Exactly `{"x_mm":0,"y_mm":102}`; finite values within +/-200 per axis |
| POST | `/sim/takeout` | `{}` removes all, or `{"count":1}` removes oldest simulated darts |
| POST | `/sim/reset` | Empty object/body; clear rig and adopt baseline, **no takeout events** |

Simulator routes return 409 for replay and rendered sources. `cameras` entries have `id`,
`calibrated`, `available`, and `frameUrl`. `pending` contains `stableFrames`,
`requiredFrames` (3), `adoptingBaseline`, `reviewRequired`, and `uncertaintyMm`.
Camera failures set status `Error`
and populate `faults`; heartbeat continues to distinguish process liveness from
valid detection.

```sh
curl -N http://127.0.0.1:8091/events
curl http://127.0.0.1:8091/state
curl -X POST http://127.0.0.1:8091/sim/throw \
  -H 'Content-Type: application/json' -d '{"x_mm":0,"y_mm":102}'
curl -X POST http://127.0.0.1:8091/sim/takeout -d '{}'
```

### Event and reconnect semantics

- Throws use `source: "board"`, stable session-qualified unique IDs, UTC ISO
  timestamps, and measured `coords: {x: x_mm/170, y: y_mm/170}` (x right, y up).
  Segments/values match `packages/schema/src/board.ts`: 7/17 bull boundaries,
  97..107 triple, 160..170 double, clockwise order starting at 20. Exact radial
  boundaries are defined in the unit tests; measured impacts have raster error.
- Full stable disappearance emits `takeout.started`, then `takeout.completed`.
  Partial disappearance emits only started; completed waits for all views empty.
  An impact during partial takeout or simultaneous multiple additions blocks
  scoring with a latched review fault until explicitly reset. One-to-one
  occupancy matching prevents an existing point from hiding multiple changes.
- `/control/reset` never emits a throw/takeout or removes the visible darts.
  Stop/re-arm and process startup similarly adopt the current stable occupancy;
  darts thrown while stopped are not retrospectively scored. Stop/start does
  **not** clear a review fault; `/control/reset` (or `/sim/reset`) is required.
  Reset adopts rejected visible impacts without scoring them; any manual match
  correction belongs downstream, not to the detector. Removing adopted
  darts later is still a real image-observed takeout.
- Heartbeat is `{"type":"board.heartbeat"}` approximately once per second,
  plus an immediate numbered heartbeat for each fresh SSE subscription.
  Status changes use `board.status` with schema-compatible status/running.
- Fresh SSE connections never replay historic throws. Under the event-history
  lock, the service captures the current cutoff and immediately allocates a new
  numbered heartbeat. After the `: connected` comment, that heartbeat is the first
  event, with an `id: SESSION:COUNTER` reconnect cursor; subsequent events follow
  normally. Persist that ID immediately so a disconnect before the next periodic
  heartbeat can replay throws received during the gap. `Last-Event-ID` reconnects
  replay normally without allocating another handshake heartbeat. No named SSE
  event is used; consumers read normal messages.
- `Last-Event-ID` replays events strictly after that ID from a bounded 512-event
  history. Invalid, foreign-session, future, or expired IDs get HTTP 409 **before
  opening SSE**. Fetch `/state` and explicitly reconnect without the header to
  resume live observation. This resync cannot recover lost scoring events.
- Session changes on process restart; history is in-memory, not persistent.
  Slow connected consumers that fall outside history are disconnected rather
  than silently skipping events. Event allocation, history, controls, snapshots
  and heartbeat publication share a lock; socket writes do not hold it.

## Rendered camera protocol and reconstruction

All render routes require `--source rendered` (409 otherwise). No coordinate,
mesh identity, segment, occupancy, or expected-score fields are permitted. Objects
are exact-key validated, including each camera and the image set. Invalid input
returns 400 and leaves the previous configuration/frame set untouched.

### Configuration

`POST /render/configure` accepts exactly `width`, `height`, and `cameras`.
The browser renderer defaults to 1280x720; 640x480 replay/configurations remain supported. `cameras` contains exactly `cam0`, `cam1`, and
`cam2`; every camera contains exactly these fields:

| Field | Value |
| --- | --- |
| `K` | Nine finite numbers, row-major pinhole intrinsics; e.g. `[400,0,320,0,400,240,0,0,1]` at 640x480 |
| `R` | Nine finite numbers, row-major proper world-to-camera rotation |
| `t` | Three finite numbers, world-to-camera translation in millimetres |
| `reference` | Base64-encoded raw grayscale bytes of the empty board |

Exactly three cameras are mandatory.
World units are millimetres: board `z=0`, x right, y up, z towards the player.
`camera = R * world + t` uses **OpenCV x right, y down, z forward**, not a Three
view matrix without axis conversion. K has positive focal lengths and pinhole
last row `[0,0,1]`. R must be orthonormal with determinant +1. Calibration also
checks camera placement, visible bull, camera baselines and reconstruction
conditioning. Lens distortion is not supported.

Dimensions must be integers in 64..1280 by 64..720. Three 1280x720 raw base64
images use 3,686,400 bytes plus small JSON/calibration overhead, fitting the bounded
6 MiB configure/frames cap enforced by the detector and both proxies (including
raw request reads). Reset and other detector JSON routes retain 4096-byte caps.
Capture budgets remain 24 MiB / 16 batches and 8 MiB configuration, conservatively
counting two bytes per JSON character: normally three 720p batches fit.
The renderer converts provisional horizontal 100° exactly using
`vfov = 2 * atan(tan(hfov / 2) * height / width)`; FOV stays adjustable. Camera
module listings are inconsistent and actual lens/intrinsic calibration is needed.
Default mounting is still radius 260 mm, forward 220 mm, rotation 60°; this is not
measured hardware geometry. K uses equal pixel focal lengths and principal point
(640,360) at 720p. Overview and camera previews preserve 16:9. Detection still
receives full-resolution grayscale bytes, not color or resized display canvases.
720p has three times the pixels of 640x480. Pure-Python processing, framebuffer
readback, base64 transport and capture copies can cost more latency/memory; no
real-time or hardware accuracy claim is implied. Synthetic/replay defaults remain
unchanged. Reevaluate old tuning on version-4 pixels before reuse or promotion;
no expensive corpus generation, tuning or promotion is automatic.
No compressed image formats or data-URL prefixes are accepted. Pixels are one
unsigned byte per pixel, row-major, top row first, with exact decoded size.

`reference` must be a genuinely empty board rendered with the same cameras,
lighting, geometry and grayscale conversion as future frames. An image-only
service cannot independently certify that the supplied reference contains no
darts; supplying an occupied reference hides that occupancy. No reference truth
labels are accepted to bypass this limitation.

Success is `{"ok":true,"session":"new-render-session-uuid"}`. Reconfiguration
clears previous occupancy and adopts the next stable set without scoring or
takeout. It **does not change the service/SSE session or erase event history**.
`GET /state` exposes `source: "rendered"`, `renderSession`, dimensions, latest
accepted upload sequence/timestamp, camera availability, pending stability,
faults, and detector-derived per-camera `diagnostics` (candidate image lines and
reconstructed impacts/uncertainty/reprojection error). Diagnostics are measurements,
not renderer truth. Gray PNG previews remain available when uploads stall.

### Frames and reset

`POST /render/frames` takes exactly:

```json
{
  "session": "render-session-from-configure",
  "sequence": 0,
  "timestampMs": 0,
  "images": {"cam0": "base64gray", "cam1": "base64gray", "cam2": "base64gray"}
}
```

Sequence is an integer >=0; timestamp is finite and >=0. Both must **strictly
increase** in the current render session. Sets are decoded/validated atomically.
Stale sessions, duplicates, missing/extra cameras, and extra fields are rejected.
The bounded worker queue holds six full sets. HTTP frame receipt uses a separate
acquisition lock, so shaft processing does not block acknowledgements or receive
timestamps. A full queue applies backpressure for at most 2.5 seconds, then
returns 400 without advancing sequence/timestamp. Sessions are rechecked after
waiting; pending uploads from an old configuration cannot enter a new one. No
frames are dropped, overwritten or automatically retried to make room. Prefer
awaiting one upload response at a time. PNG encoding also runs outside the state
lock after taking a consistent pixel/dimension snapshot.

Send **three independently uploaded identical sets** to establish stability.
Worker ticks without a new upload never count as stable observations. Changed
pixels break stability. No frames for >3 seconds faults the source and clears
pending stability; three fresh sets are needed after recovery. The timestamp is
client capture metadata only; liveness uses the server's monotonic receive clock.

`POST /render/reset {"session":"current-render-session"}` discards queued sets
and adopts the next stable occupancy, like `/control/reset`. It neither clears
physical images nor scores/takes out. The token remains valid; use configure for
rig/reference changes. `/control/start`, `/control/stop`, `/control/reset`, and
SSE retain their existing safety semantics.

### Pixel-only algorithm and known limits

1. Difference each image against its empty reference (24 gray levels). Reject
   large lighting changes, edge clipping, tiny/unresolved regions and too many
   disconnected silhouettes.
2. Connected changed regions propose Hough line directions. Fit centers of a
   contiguous **narrow shaft run**, excluding broad flight/barrel cross-sections;
   this is not PCA of the whole flight or a tip-centroid detector. The tip need
   not be visible. Runs need roughly 21 pixels of usable length, and changed
   shaft widths up to nine pixels. This constrains observability, not mesh shape.
3. Back-project image line `l` to the world plane with normal `R^T K^T l` and
   offset `(K^T l) dot t`. Fit the three planes' shaft axis, intersect with z=0,
   require well-conditioned geometry, and check reprojection in all three views.
   Correspondence must be unique; no two-camera fallback guesses an occluded view.
4. Propagate subpixel line-offset and observed-run angular errors to an impact
   uncertainty. The radius is `max(1 mm, propagated endpoint-error radius)`, using
   simultaneous offset/angular perturbation corners in all three cameras. The
   previous extra additive 1 mm allowance is now a minimum raster bound; the
   legacy parameter threshold still makes the same shaft-refinement decisions.
   Reconstructed diagnostics expose the model, propagated radius and minimum
   radius in `uncertaintyDetails`. Scoring-boundary uncertainty still latches
   review rather than guessing a segment. This empirical raster guard is **not
   calibrated statistical confidence** or a hardware accuracy claim; optical,
   calibration and systematic shaft-fit errors need independent hardware evidence.
5. Track full-reference occupancy and compare changed pixels with the last
   accepted set. A changed silhouette without resolvable occupancy change faults
   rather than silently treating a merged extra dart as an old dart. Separated
   shafts can be added/removed independently; completion requires all three
   views empty. Repeated identical uploads do not duplicate a score.

Initial operation assumes fixed lighting, no changing shadows, synchronized
static rendered sets, sufficient shaft contrast against board artwork, and
exact temporal pixel stability. Low contrast, antialias fragments, broad/short
shafts, flight edges competing with the shaft, merged/clustered darts, and
occlusion may fail closed. This initial connected-region implementation does
**not reliably separate clustered silhouettes**. Completely hidden identical
additions cannot be observed. The service cannot distinguish deliberately
re-uploaded old images with fresh sequence numbers from fresh browser captures.
No hand classifier, real-camera noise model, physical lens calibration, or
browser-renderer integration accuracy is claimed. Independent analytic 120-degree
cameras (radius 260 mm, forward offset 100 mm) and projected shaft/flight pixels
exercise geometry, invisible-tip reconstruction, upload protocol and safety in
`test_rendered.py`; they do not validate real hardware or the Three renderer.

## Synthetic/replay image pipeline and limitations

`tools/camera-sim/rig.py` owns simulated coordinates privately and renders actual
480x480 grayscale images. `capture()` returns only `{camera_id: bytes}`. The
same acquisition interface is implemented by `ReplaySource`, whose manifest
contains calibrations, an empty reference and image filenames only. The detector
never receives simulator positions, segments, throw commands, occupancy metadata,
or expected event labels.

Every camera uses a known affine board-plane calibration. The detector differences
current pixels against an empty reference, extracts connected silhouettes, checks
marker size/shape, maps image centroids back to the board plane and requires
unambiguous one-to-one agreement within 3 mm **across all two/three views**.
Three consecutive identical image sets are required (~300 ms at 10 Hz) before
occupancy transitions can produce events. Missing/unknown views, bad calibration,
invalid images, inconsistent occupancy and ambiguous silhouettes fail closed.

Before scoring, an uncertainty disk must be clear of every radial scoring
boundary and of the sector wires between the outer bull and outer double. Its
radius is **at least 1 mm**, increased for inverse-calibration raster amplification
and measured cross-view disagreement. An uncertain impact emits no throw and
latches `status: Error`, `pending.reviewRequired: true`, and a descriptive fault.
Later movement or stop/start cannot make that rejected impact score. Explicit
reset is required to adopt current occupancy and resume. The inherited 7/17 bull
radii are retained for compatibility, not independently audited here.

Camera previews include calibrated grayscale rings, bulls and alternating sectors
in the empty reference itself. Every shade remains sufficiently brighter than the
marker for the original differencing threshold to extract the full silhouette.
Artwork is only source imagery; it supplies no impact/segment truth to detection.

This deliberately detects planar, high-contrast round tip markers, not real
perspective shafts. Fixed lighting and exact pixel stability are unrealistic for
live video. Close/merged silhouettes and ambiguous identities fault; an exactly
hidden/identical impact cannot be observed and will not be scored. Very small
occluded changes can also be indistinguishable from rasterization. There is no
hand classifier, bounce-out detection, off-image miss inference or physical
camera synchronization. The uncertainty margin is a conservative synthetic-raster
guard, not a validated hardware confidence model: systematic calibration errors
and real-camera effects are not bounded by it. A recorded-image replay passing
only proves this constrained pipeline. Before hardware use: calibrated lens/perspective models, synchronized
acquisition, robust temporal/noise thresholds, shaft/tip geometry, occlusion
handling, and captured-camera validation are necessary. No hardware accuracy is
claimed.
