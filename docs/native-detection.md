# Native detection playground

Experimental camera simulation and image detection. For features and installation, see the [README](../README.md).

Requires **Python 3.10+** as well as Node 24+. Run `npm ci` before starting the services. No Python packages, camera permissions, cloud service, or Autodarts installation are needed for this synthetic development path. USB capture has additional dependencies described below.
Start these in separate terminals:

```sh
npm run dev:detector
SOURCE=native DETECTOR_URL=http://127.0.0.1:8091 npm run dev:bridge
npm run dev:server
npm run dev:frontend
```

In **Settings → Dart source**, select **Native detector**, test the local URL,
and apply it. A stored source choice overrides the bridge environment on server
reconnect, so explicitly apply native if you previously saved another source.
The camera diagnostics panel shows the three synthetic views and controls for
adding an impact in millimetres (x right, y up), removing some/all darts, and
resetting the simulated scene. Start a match before adding darts. Wait for an
adopted baseline, stable frames and `Throw` between impacts. The default
`x=0, y=102` is T20; use separated coordinates for subsequent darts rather than
putting two invisible-overlapping markers at the same point.

**This tests images, not injected scores.** The simulator renders grayscale
frames; the detector differences them against the empty reference, extracts tip
silhouettes, reconciles measured coordinates across calibrated views, and waits
for temporal stability. Only then does it score the impact and send our own
board events through the bridge and server. Synthetic coordinates and expected
segments are not given to the detector. Native mode rejects virtual-board
segment injection; use the camera simulator controls instead.

The third dart holds the turn until image-observed full takeout. Partial removal
does not advance the player. Reset adopts the current occupancy without emitting
throws or a takeout. Native throws disable legacy "a new throw proves missed
takeout" recovery: a fourth visible dart cannot advance the player by itself.
Missing/ambiguous views and uncertain near-wire impacts fail closed, with a
reset-required review fault rather than a guessed score. Clear the scene and
reconcile the match manually before resetting after uncertainty.

Validation and deterministic image replay:

```sh
npm run test:detector
npm run test:native     # real Python → bridge → server, temporary DB, no hardware
npm run check:native   # TypeScript checks/tests + Python tests + native smoke
python3 services/detector/main.py --source replay --replay testdata/vision/sequence.json
```

Camera previews use same-origin allowlisted server/bridge proxies. The detector
binds only to loopback; remote phones view it through the existing server. Like
other game controls, the proxies are not authenticated: use a trusted LAN and
do not expose the server publicly. The desktop installer includes the detector executable and model; Docker still uses a separately started detector.

The browser also offers a **3D camera rig** with actual dart meshes and calibrated
perspective views. Its default representative LED ring uses twelve spot lights at
270 mm radius and 180 mm forward offset, intensity 1, and ambient intensity 0.35.
Each light casts a 512×512 PCF shadow; calibrated render targets use 4× MSAA and
reuse shadows until the scene changes. These are simulation settings, not measured
hardware lighting. Desktop launches manage the rendered detector process.

Rendered cameras default to **1280×720** (16:9), with a provisional **100° horizontal
FOV** converted exactly to vertical FOV by
`2 * atan(tan(100° / 2) * 720 / 1280)` (about **67.67°**). Vertical FOV remains
adjustable; the rig retains radius 260 mm, forward offset 220 mm and rotation 60°.
Camera module listings give inconsistent viewing angles; this is not a measured
lens calibration. Actual hardware needs intrinsic/lens calibration, including distortion.
The narrower vertical view may crop the outer board. Overview and previews also use
16:9 without stretching. Inputs remain full-resolution top-down grayscale, not color
detection or downsampled previews. Three raw base64 frames occupy about 3.69 MB of
JSON; only render configure/frames allow 6 MiB through server, bridge and detector.
Reset retains a 4096-byte cap. Synthetic defaults and 640×480 replay compatibility
are unchanged. 720p has three times the pixels of 640×480: pure-Python processing,
readback, encoding, uploads and bounded capture copies may increase latency; no
real-time throughput or accuracy claim is made.

The original synthetic/replay source
uses planar markers. An offline labelled rendered suite and resumable Python tuner
are available via `npm run detector:generate`, `detector:evaluate`, and
`detector:tune`; see the detector README for complete commands. Labels never enter
the detector, images are cached once, and tuning never changes active parameters.

In the rendered-source panel, click the overview board to place the next configured
3D dart; drag to orbit without placing. Placement obeys the same acknowledged-frame,
stability, session, fault and takeout guards as the insert button. Green rings mark
actual board entries, pink rings show the latest pixel-only reconstruction, and amber
rings show its uncertainty radius. These annotations exist only on overview layer 1;
none enters the three grayscale camera inputs. Nearest-tip errors are comparisons,
not dart identity assignments or scoring receipts. Actual and reconstructed tips also show
coordinate-derived segment labels/points using schema board geometry; a reconstructed
T20 does **not** mean the detector accepted T20. Raw diagnostics remain available.

Rendered uncertainty uses the propagated pixel/shaft-angle error with a **1 mm
minimum radius**, rather than adding a further 1 mm to that error. An impact still
requires its entire uncertainty disk to stay within one scoring bed. Diagnostics
expose the radius components; offline evaluation reports measured errors against
the bounds, including otherwise eligible scoring rejections. This is an empirical
guard checked on simulated pixels, not calibrated hardware confidence. Existing
parameter files retain their shaft-refinement decisions; code changes invalidate
older tuning checkpoints, so reevaluate their candidates before further tuning.

The dart's `(x, y, 0)` is the **axis/board entry**, still the target for reconstruction,
labels and scoring, not the buried physical apex. **Axial penetration** is measured
along the tilted dart axis (default 8 mm; omitted legacy values also use 8 mm).
The physical apex is `entry - penetration × unitAxis`; board-normal burial is
`penetration × unitAxis.z`. Point length now means total physical length, unchanged
at 10–45 mm; penetration is 0–20 mm and must leave at least 2 mm before the barrel.
Zero restores the exposed apex. Buried dart material is clipped at the board plane;
existing length/width limits and the 217 mm maximum axial envelope are not enlarged.
Board number labels, like comparison overlays, are overview-only layer 1.

The board already had raised round wires. Their shared mesh/placement model uses
schema scoring radii and all 20 wedge boundaries, with representative 0.55 mm wire
radius and 0.6 mm centre height—not measured hardware dimensions. Optional
**successful-entry wire-clear placement** conservatively rejects the tilted steel
point footprint across the raised-wire slab, including wire endpoints, with an
explicit message and no snapping. It applies to click, insert and preview presets.
Bulls and the physical miss surround are allowed beds; wedge wires stop at the outer
double. Unchecked **unrestricted** mode permits wire-overlapping stress scenes.
This is a geometric placement filter, not a guarantee of physical entry: it does
not model dart collisions, deformation, material properties or bounce-outs.
Wire-bounce scenarios are deferred.

Rendering changes invalidate version-2/3/4/5 image benchmarks: scenario/cache version
is now 6, with the representative LED ring and shadows added to the rendered scene.
It retains 1280×720 images and the explicit 100° horizontal baseline, replacing the
benchmark’s custom 95° vertical FOV, plus explicit 8 mm axial penetration and
deliberately unrestricted near-wire cases. The default suite adds independent
scoring-boundary cases and three train-only regressions at the default desktop
mount, including the first dart at (0, 102) and a three-dart removal sequence.
Generate into a new output directory only when requested;
old cached images remain historical artifacts. Previous tuned parameters and
benchmark results require reevaluation on newly rendered pixels before reuse or
promotion. No dataset generation, retuning or parameter promotion happens
automatically.

**Reset playground** explicitly stops the old upload session, clears all scene darts,
and configures the existing rendered service with an empty reference. It does not
undo match scores or emit takeout: reconcile the match manually first. It requires
the upload-risk acknowledgement and a running rendered source; fresh session,
stability and acknowledgement guards still apply. There is no automatic reset/rearm.
A detector rejection intentionally stops uploads. Its original reason stays visible;
a later `stream stalled` diagnostic is secondary to that stop, not a replacement
explanation. Stop uploads also intentionally produces a later stale stream.
Frame receipt is independent of shaft processing, allowing the browser to keep
uploading while a slow frame is analyzed. A full six-batch queue waits up to
2.5 seconds for space before rejecting; it never drops or automatically resends
pending frames to make room. A genuine absence of uploads still trips the three-second stream
watchdog. Switching tabs pauses diagnostics and disarms rendered uploads, so a
later stall after leaving the simulator or stopping it is expected.

**Export first failure JSON** downloads an offline, versioned capture, frozen at the
first fault until explicitly discarded (even across reset). It contains the exact
submitted configure payload including empty camera references, a recent window of
submitted grayscale batches, per-batch scene darts/rig as separate offline truth,
and the state/diagnostics available at the fault. Labels are never sent to the
detector. The window is bounded to 16 batches / 24 MiB, configuration to 8 MiB,
state metadata to 256 KiB; oversized entries are omitted. Image/configuration
budgets conservatively count two bytes per JSON character; at 720p the window
usually retains only three full batches, not sixteen. This is browser memory
only, cleared on panel teardown, with no automatic disk persistence. Review images
and diagnostics before sharing the user-initiated download.

The JSON supplies camera matrices/references and image batches for offline replay;
it is not the existing benchmark dataset format or an automatic replay importer.
Polling does not bind diagnostics to a submitted frame sequence, so the capture
cannot prove which frame was rejected or accepted. Submission is not acceptance.
Parameter/build provenance is unknown unless exposed in existing state diagnostics;
no parameter file is fetched or inferred and no match history is exported.

**Rendered uploads are not match-isolated.** Accepted detections score the active
match, and image-observed takeout can advance its turn. Enabling uploads requires
acknowledging this warning. Use a disposable match (which still affects history/stats)
or a separate server/database for experiments. Scene-only preview uploads nothing;
stopping uploads or closing the panel does not request takeout.

To see a reviewed tuning candidate in this panel, export the plain
`selected.parameters` object and evaluate the held-out split using the commands in
[`services/detector/README.md`](../services/detector/README.md#offline-rendered-evaluation-and-tuning).
Stop the existing detector, including any desktop-managed process, then explicitly
start it from the repository root:

```sh
python3 services/detector/main.py --source rendered --parameters build/rendered-benchmark/candidate.json --port 8091
```

Use the browser development bridge/server/frontend stack, apply **Native detector**
with URL `http://127.0.0.1:8091`, start detection, and enable uploads in the rendered
panel. Do not launch a second detector on the same port. This startup flag accepts a
validated plain, possibly partial parameter object—not the enclosing tuning artifact.
Omitting it uses defaults; the panel never loads or promotes a candidate automatically.

**Limitations:** perspective detection remains experimental and rejects many
rendered cases; the benchmark has also exposed wrong acceptance. USB acquisition and manual board-point pose calibration are experimental; there is no lens distortion calibration, hand classifier, robust
live-video stability model or hardware accuracy claim.
Autodarts remains the supported real-board source. See
[`services/detector/README.md`](../services/detector/README.md) for the protocol,
replay format, safety behaviour and prerequisites for hardware use.


## Experimental USB capture

Install the dependencies in `services/detector/requirements-live.txt` in a Python environment, then start the detector with
three distinct stable device paths, in calibration order:

```sh
python3 services/detector/main.py --source usb --camera-config rig.json \
  --device /dev/v4l/by-id/camera0 --device /dev/v4l/by-id/camera1 --device /dev/v4l/by-id/camera2
```

If `rig.json` does not exist, the detector starts stopped in Setup with live camera
previews. All three cameras must support 1280×720, the resolution used for v6 training.
In Settings → Native detector → Calibrate USB cameras, clear the board and capture
images, enter each lens's measured horizontal field of view at that resolution,
and mark the bull and eight specified outer-double wire intersections in each view.
All landmarks must be visible. The service fits a pinhole pose, checks reprojection
error and three-view geometry, then saves the empty reference and rig atomically to
`--camera-config`. Detection remains stopped until explicitly started. Recalibrate
if a camera, resolution, focus or board moves. Reconcile the match manually first;
calibration does not correct scores or issue takeout.

The model assumes square pixels, a centred principal point and negligible lens
distortion; it does not measure intrinsics or distortion. A low board-point fit
error cannot establish accurate off-board shaft reconstruction. Validate the
calibration and detector on real hardware before relying on scores. Camera access
permissions and sufficient USB bandwidth are required. Capture failures and
resolution mismatches appear as detector faults. The rig uses the rendered
`/render/configure` JSON format.

For hardware-free capture testing, replace the device arguments with
`--mock-cameras frames.json`. The manifest is a nonempty JSON array of objects
mapping cam0, cam1 and cam2 to P5 grayscale PGM paths relative to the manifest.
Frames use the rig dimensions; the final batch repeats. This exercises the same
perspective processing and native bridge without Autodarts. Mock frames do not
validate hardware timing, lens distortion or detection accuracy.


### V6 inference on USB frames

USB mode loads the bundled `services/detector/models/presence-v6.pt` by default; use `--model` to select a different checkpoint.
The selected v6 weights are identical to the retained v4 checkpoint. The model
compares each RGB frame with the last accepted frame, using the training resize
and decoder. A geometric throw is accepted only if every v6 presence score is
at least 0.5 and all three keypoints agree with its segment with 3 mm clearance.
A failure latches a review fault. This is an experimental combined pipeline,
not an independently validated live v6 scoring model; the geometric detector still
proposes throws and detects removals. USB acquisition uses a three-frame stability window with a per-pixel noise threshold before geometric processing; this has not been validated on physical cameras. Continuous hands and takeout, other
mounts, optical distortion, performance, and combined-pipeline error rates have
not been validated. Mock PGM frames are grayscale expanded to RGB and cannot
validate colour-dependent model behavior.

The desktop installer bundles the detector runtime and checkpoint. In Settings, select and apply **Native detector**, then use **USB cameras** to choose and connect the three devices. The **Calibrate USB cameras** panel appears after connection. The app stores the selection and calibration in its data directory and attempts to reconnect on restart. To change camera assignments, disconnect first. See the [desktop guide](../packages/desktop/README.md) for optional launch configuration.
