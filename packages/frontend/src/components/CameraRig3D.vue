<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { CameraRig3D, CAMERA_IDS, FRAME_WIDTH, FRAME_HEIGHT, DEFAULT_DART, DEFAULT_RIG, validDart, validRig, placementProblem, type DartSpec } from '../cameraRig3d.ts';
import { RenderedCapture } from '../renderedCapture.ts';
import { PlaygroundCapture, playgroundSegment } from '../playgroundCapture.ts';
import { placementClick, renderedResults, renderedBaselineReady, renderedSnapshotGate, type NativeState } from '../nativeDetector.ts';
import { api } from '../store.ts';

const props = defineProps<{ snapshot: NativeState | null }>();
const overview = ref<HTMLCanvasElement | null>(null);
const previews = ref<HTMLCanvasElement[]>([]);
const rig = reactive({ ...DEFAULT_RIG });
const dart = reactive({ ...DEFAULT_DART });
const darts = ref<DartSpec[]>([]);
const preset = ref('perpendicular');
const problem = ref<string | null>(null);
const failureCapture = new PlaygroundCapture();
const firstFault = ref<string | null>(null);
function recordFault(reason: string): void {
  if (failureCapture.freeze(reason, props.snapshot)) firstFault.value = reason;
}
function discardCapture(): void {
  failureCapture.clear(); firstFault.value = null;
}
function exportCapture(): void {
  const json = failureCapture.export();
  if (!json) return;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'rendered-failure.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
const message = ref('Scene-only preview. Detection is off; no frames are uploaded.');
const available = ref(false);
const session = ref<string | null>(null);
const configuring = ref(false);
const renderConfirmed = ref(false);
const pending = ref(false);
const scoringAcknowledged = ref(false);
const clickPlacement = ref(true);
const wireClear = ref(false);
const placementError = ref<string | null>(null);
const results = computed(() => renderedResults(props.snapshot));
const comparisons = computed(() => results.value.map(result => ({ ...result,
  errorMm: darts.value.length ? Math.min(...darts.value.map(d => Math.hypot(d.x - result.x, d.y - result.y))) : null,
})));
let gesture: { id: number; x: number; y: number; movement: number; allowed: boolean } | undefined;
function pointerDown(event: PointerEvent): void {
  if (gesture) { gesture = undefined; return; }
  if (event.button !== 0 || !event.isPrimary) return;
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, movement: 0, allowed: canAdd.value };
}
function pointerMove(event: PointerEvent): void {
  if (gesture?.id === event.pointerId) gesture.movement = Math.max(gesture.movement, Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y));
}
function pointerUp(event: PointerEvent): void {
  const start = gesture; gesture = undefined;
  if (!start || start.id !== event.pointerId || !start.allowed || !clickPlacement.value || !canAdd.value ||
      !placementClick(start, { x: event.clientX, y: event.clientY }, start.movement)) return;
  const point = renderer?.pickImpact(event.clientX, event.clientY);
  if (!point || !validDart({ ...dart, ...point })) return;
  Object.assign(dart, point); add();
}
const ack = ref(-1);
let renderer: CameraRig3D | undefined;
let capture: RenderedCapture | undefined;
let configureController: AbortController | undefined;
let animation = 0;
let lastPreview = -Infinity;
let disposed = false;
let generation = 0;
let sceneSnapshot: NativeState | null = null;
let configuredSnapshot: NativeState | null = null;
let changedAfterAck = -1;
let detectorSession: string | undefined;

const settled = computed(() => renderedBaselineReady(props.snapshot, renderConfirmed.value));
function snapshotGate(state: NativeState | null) {
  return renderedSnapshotGate(state, { detectorSession, renderSession: session.value,
    configuring: configuring.value, confirmed: renderConfirmed.value, previousSnapshot: configuredSnapshot });
}
const canChange = computed(() => available.value && !configuring.value &&
  (!session.value || (props.snapshot !== configuredSnapshot && settled.value && !pending.value && ack.value > changedAfterAck)));
const canAdd = computed(() => canChange.value && validDart(dart) && darts.value.length < 12 &&
  (!session.value || props.snapshot?.status === 'Throw'));
const canConfigure = computed(() => scoringAcknowledged.value && available.value && !configuring.value && validRig(rig) &&
  props.snapshot?.source === 'rendered' && props.snapshot.running);
const diagnosticText = computed(() => props.snapshot?.diagnostics
  ? JSON.stringify(props.snapshot.diagnostics, null, 2).slice(0, 8192) : 'No reconstruction diagnostics yet.');

function disarm(reason: string): void {
  generation++; capture?.stop(); configureController?.abort(); configureController = undefined;
  configuring.value = false; renderConfirmed.value = false; session.value = null; pending.value = false; ack.value = -1;
  message.value = reason;
}
function updateScene(): void {
  renderer?.setDarts(darts.value);
  renderer?.setMarkers(darts.value, []);
  if (session.value) {
    pending.value = true; sceneSnapshot = props.snapshot; changedAfterAck = ack.value;
    message.value = 'Scene changed. Waiting for acknowledged images and a fresh, adopted detector baseline.';
  }
}
function add(): void {
  if (!canAdd.value) return;
  placementError.value = placementProblem(dart, wireClear.value);
  if (placementError.value) return;
  darts.value.push({ ...dart }); updateScene();
}
function remove(all: boolean): void {
  if (!canChange.value) return;
  if (all) darts.value = []; else darts.value.shift();
  updateScene();
}
function selectPreset(): void {
  Object.assign(dart, DEFAULT_DART, preset.value === 'tilted' ? { x: 28, y: 100, tiltX: 22, tiltY: -16, roll: 35 }
    : preset.value === 'clustered' ? { x: -8, y: 100, tiltX: 12, tiltY: 7, roll: 20 } : {});
}
function demo(): void {
  if (session.value || configuring.value || !available.value) return;
  selectPreset();
  const next = preset.value === 'clustered' ? [
    { ...dart }, { ...dart, x: 0, y: 105, tiltX: -8, roll: 60 }, { ...dart, x: 8, y: 100, tiltY: -12, roll: 105 },
  ] : [{ ...dart }];
  placementError.value = next.map(d => placementProblem(d, wireClear.value)).find(Boolean) ?? null;
  if (placementError.value) return;
  darts.value = next;
  updateScene();
}
async function enable(): Promise<void> {
  if (!canConfigure.value || !renderer) return;
  disarm('Configuring an empty scene; previous preview darts are cleared without scoring or takeout.');
  problem.value = null; configuring.value = true;
  darts.value = []; renderer.setDarts([]); renderer.setMarkers([], []);
  const current = generation;
  const controller = new AbortController(); configureController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    // Recheck source immediately before the only configure call. Never use the marker simulator.
    if (props.snapshot?.source !== 'rendered') throw new Error('Detector must be started with source rendered');
    configuredSnapshot = props.snapshot; detectorSession = props.snapshot.session;
    const configuration = renderer.configuration();
        failureCapture.configure(configuration);
        const result = await api.nativeRenderConfigure(configuration, controller.signal);
    if (disposed || current !== generation) return;
    if (!result || result.ok !== true || typeof result.session !== 'string' || !result.session) throw new Error(result?.error ?? 'Invalid render configuration response');
    session.value = result.session; changedAfterAck = -1; ack.value = -1;
    message.value = 'Detection enabled. Waiting for all cameras to adopt the empty reference.';
    capture?.start(result.session);
  } catch (error) {
    if (disposed || current !== generation) return;
    recordFault((error as Error).message);
        disarm('Detection disabled. Clear the problem and explicitly reconfigure before retrying.');
    problem.value = (error as Error).message;
  } finally {
    clearTimeout(timeout);
    if (current === generation) { configuring.value = false; configureController = undefined; }
  }
}
watch(rig, () => {
  disarm('Rig changed: capture disarmed. Enable detection to reconfigure an empty scene.');
  if (validRig(rig)) renderer?.setRig(rig);
  else message.value = 'Invalid rig settings. Restore valid dimensions before configuring.';
});
watch(() => props.snapshot, state => {
  renderer?.setMarkers(darts.value, renderedResults(state));
  if (!session.value && !configuring.value) return;
  const gate = snapshotGate(state);
  if (gate === 'invalid') {
    const reason = state?.faults.length ? state.faults.join('; ') : 'Detector unavailable or restarted';
        recordFault(reason); problem.value = firstFault.value;
        disarm('Safety stop: uploads intentionally stopped after the original fault. A later stream stall is secondary, not a new upload failure. No takeout requested.'); return;
  }
  if (gate === 'stale') {
    recordFault('Render session is stale');
        disarm('Render session is stale. Uploads stopped; explicitly configure an empty scene again.'); return;
  }
  if (gate === 'waiting' || !state) return;
  renderConfirmed.value = true;
  if (pending.value && state !== sceneSnapshot && settled.value && state.occupancy === darts.value.length && ack.value > changedAfterAck) {
    pending.value = false; message.value = 'Scene adopted by detector. Ready for the next scene change.';
  }
});
function contextLost(event: Event): void {
  event.preventDefault(); recordFault('WebGL context lost'); available.value = false; cancelAnimationFrame(animation);
  disarm('WebGL context lost. Detection stopped; reopen settings to recreate the renderer.');
  problem.value = 'WebGL context lost. Enable hardware acceleration in your browser/Electron and reopen settings.';
}
onMounted(() => {
  try {
    if (!overview.value || previews.value.length !== 3) throw new Error('Preview canvases unavailable');
    renderer = new CameraRig3D(overview.value, previews.value, rig);
    overview.value.addEventListener('webglcontextlost', contextLost);
    available.value = true;
    void renderer.enableOrbit().catch(error => { if (!disposed) problem.value = `Orbit controls unavailable: ${(error as Error).message}`; });
    capture = new RenderedCapture(() => {
      const gate = snapshotGate(props.snapshot);
      if (!renderer || !session.value || gate === 'invalid' || gate === 'stale') throw new Error(props.snapshot?.faults.join('; ') || 'Detector no longer ready for rendered frames');
      // Before session confirmation, insertion is locked: these remain empty baseline frames.
      return renderer.frames();
    }, (batch, signal) => {
      failureCapture.submit(batch, darts.value, { ...rig });
      return api.nativeRenderFrames(batch, signal);
    }, error => {
      recordFault(error);
      disarm('Frame upload failed. No automatic retry or takeout; explicitly reconfigure to continue.'); problem.value = error;
    }, sequence => { ack.value = sequence; });
    const draw = (now: number) => {
      if (disposed) return;
      try {
        renderer?.renderOverview();
        if (!session.value && !configuring.value && now - lastPreview >= 200) { renderer?.frames(); lastPreview = now; }
      } catch (error) {
        recordFault((error as Error).message);
                disarm('Rendering failed. Detection stopped.'); problem.value = (error as Error).message; available.value = false; return;
      }
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
  } catch (error) {
    renderer?.dispose(); renderer = undefined;
    problem.value = `3D preview unavailable: ${(error as Error).message}. Enable WebGL/hardware acceleration in your browser or Electron, then reopen settings.`;
  }
});
onUnmounted(() => {
  disposed = true; disarm('Preview closed; uploads stopped without takeout.'); failureCapture.clear(); cancelAnimationFrame(animation);
  overview.value?.removeEventListener('webglcontextlost', contextLost); renderer?.dispose(); renderer = undefined;
});
</script>

<template>
  <section class="rig-panel">
    <h3>3D camera simulator · rendered source</h3>
    <p class="hint">Real perspective images, not injected scores. World millimetres: x right, y up, z toward player;
      board-entry axis at z=0; physical tip buried along the axis. Three cameras aim at the bull, spaced 120° around the board. Previews are the same
      1280×720 grayscale framebuffers sent to the detector. No camera permission is required.</p>
    <p class="hint">The detector service must start with source <code>rendered</code> (browser or Electron).
      Mounting this panel does not enable detection. Scene-only preview is safe for Phase A visual checks.</p>
    <p v-if="problem" class="bad" role="alert">{{ problem }}</p>
    <p v-if="snapshot && !snapshot.running" class="hint">Detector is stopped. Start detection using Board controls before configuring the renderer.</p>
    <figure class="overview">
      <canvas ref="overview" :width="FRAME_WIDTH" :height="FRAME_HEIGHT" aria-label="Orbitable 3D overview, click board to insert a dart"
              @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp"
              @pointercancel="gesture = undefined" @pointerleave="gesture = undefined" />
      <figcaption>Orbitable overview — NOT a detector image. Drag to orbit, wheel to zoom, right-drag to pan.
        Click the board to insert the next dart when controls are ready; dragging does not insert.
                Actual board entries: green · latest reconstruction: pink · uncertainty radius: amber. All markers are overview-only,
                never in detector camera images. Mounts: cam0 blue · cam1 gold · cam2 purple.</figcaption>
    </figure>
    <label><input v-model="clickPlacement" type="checkbox" /> Click-to-place on overview</label>
        <label><input v-model="wireClear" type="checkbox" /> Successful-entry wire-clear placement (conservative)</label>
        <p class="hint">Unchecked: unrestricted wire-overlapping previews. Checked: reject tilted steel-point footprints touching raised circular or wedge wires; never snap. Bulls and the physical miss surround are allowed beds. No bounce simulation.</p>
        <p v-if="placementError" class="bad" role="alert">{{ placementError }}</p>
    <p class="bad">Uploads are NOT isolated: accepted detections score the active match and image takeout can advance its turn.
      Use a disposable match or a separate server/database for experiments. Stop uploads before returning to real play.</p>
    <label><input v-model="scoringAcknowledged" type="checkbox" :disabled="!!session || configuring" />
      I understand that enabling uploads can change the active match.</label>
    <p v-if="firstFault" class="bad" role="alert">Original failure (retained): {{ firstFault }}.
      Uploads intentionally stopped. Later stream-stall diagnostics do not replace this failure.</p>
    <p v-if="snapshot?.faults.length" class="bad">Current service diagnostics: {{ snapshot.faults.join('; ') }}.
      Reconcile the match manually before Reset playground; reset does not undo scores.</p>
    <ul v-if="darts.length" class="hint">
      <li v-for="(actual, i) in darts" :key="i">Actual board entry {{ i + 1 }}: ({{ actual.x.toFixed(2) }}, {{ actual.y.toFixed(2) }}) mm ·
        {{ playgroundSegment(actual.x, actual.y) }} — scene truth, not a receipt.</li>
    </ul>
    <p class="hint">{{ snapshot?.status ?? 'Unavailable' }} · stable {{ snapshot?.pending.stableFrames ?? 0 }}/{{ snapshot?.pending.requiredFrames ?? 3 }} ·
      {{ snapshot?.pending.adoptingBaseline ? 'adopting baseline' : 'baseline adopted' }}.
      Reconstructions below are latest diagnostics, not an acceptance or scoring receipt; they may persist between changes.</p>
    <ul v-if="comparisons.length" class="hint">
      <li v-for="(result, i) in comparisons" :key="i">Reconstruction ({{ result.x.toFixed(2) }}, {{ result.y.toFixed(2) }}) mm · {{ playgroundSegment(result.x, result.y) }} (coordinate-derived, NOT accepted) ·
        nearest actual tip error {{ result.errorMm === null ? 'n/a' : `${result.errorMm.toFixed(2)} mm` }} ·
        uncertainty {{ result.uncertaintyMm.toFixed(2) }} mm · reprojection {{ result.reprojectionPx.toFixed(2) }} px.
        Nearest-tip comparison is not a dart identity assignment.</li>
    </ul>
    <p v-else class="hint">No current reconstruction. Waiting, empty scenes and rejected hypotheses are not shown as detected tips.</p>
    <div class="camera-grid">
      <figure v-for="(id, i) in CAMERA_IDS" :key="id">
        <canvas :ref="el => { if (el) previews[i] = el as HTMLCanvasElement; }" :width="FRAME_WIDTH" :height="FRAME_HEIGHT" :aria-label="`${id} oblique grayscale framebuffer`" />
        <figcaption>{{ id }} · oblique perspective · {{ rig.rotation + i * 120 }}°</figcaption>
      </figure>
    </div>
    <fieldset>
      <legend>Camera rig — changes disarm capture</legend>
      <label>Circle radius (mm) <input v-model.number="rig.radius" type="number" min="230" max="600" /></label>
      <label>Forward offset (mm) <input v-model.number="rig.forward" type="number" min="40" max="600" /></label>
      <label>Rig rotation (°) <input v-model.number="rig.rotation" type="number" min="-360" max="360" /></label>
      <label>Vertical FOV (°) <input v-model.number="rig.vfov" type="number" min="45" max="130" /></label>
      <p class="hint">Viewing angle above board plane: {{ (Math.atan2(rig.forward, rig.radius) * 180 / Math.PI).toFixed(1) }}°.
        1280×720 grayscale cameras; default FOV is provisional 100° horizontal (about 67.67° vertical). Module listings disagree; actual lens calibration is required. Mount geometry is not measured Autodarts dimensions. Each camera's near rim is below the bull.</p>
    </fieldset>
    <fieldset>
      <legend>Next dart — board entry, insertion tilt and axial roll</legend>
      <label>Preset <select v-model="preset" @change="selectPreset"><option>perpendicular</option><option>tilted</option><option>clustered</option></select></label>
      <label>X (mm) <input v-model.number="dart.x" type="number" min="-225" max="225" /></label>
      <label>Y (mm) <input v-model.number="dart.y" type="number" min="-225" max="225" /></label>
      <label>Tilt toward +x (°) <input v-model.number="dart.tiltX" type="number" min="-45" max="45" /></label>
      <label>Tilt toward +y (°) <input v-model.number="dart.tiltY" type="number" min="-45" max="45" /></label>
      <label>Roll (°) <input v-model.number="dart.roll" type="number" min="-360" max="360" /></label>
      <p class="hint">Each tilt is measured from the outward board normal. Roll rotates four solid flights around the dart axis.
        Settings affect only the next dart. Impacts must lie within the 225 mm board surface; at most 12 preview darts.</p>
    </fieldset>
    <details>
      <summary>Dart dimensions (mm)</summary>
      <fieldset>
        <label>Axial penetration <input v-model.number="dart.penetration" type="number" min="0" :max="Math.min(20, dart.point - 2)" step="0.5" /></label>
                <p class="hint">Buried length along the axis, default 8 mm; zero restores an exposed apex. Point length is total physical length; penetration leaves at least 2 mm before the barrel. Coordinates and scoring remain board entry, not buried apex.</p>
                <label>Total point length <input v-model.number="dart.point" type="number" min="10" max="45" /></label>
        <label>Barrel length <input v-model.number="dart.barrel" type="number" min="25" max="65" /></label>
        <label>Barrel diameter <input v-model.number="dart.barrelDiameter" type="number" min="4" max="10" step="0.1" /></label>
        <label>Shaft length <input v-model.number="dart.shaft" type="number" min="15" max="60" /></label>
        <label>Flight length <input v-model.number="dart.flightLength" type="number" min="20" max="55" /></label>
        <label>Flight radial width <input v-model.number="dart.flightWidth" type="number" min="8" max="25" /></label>
        <label>Flight thickness <input v-model.number="dart.flightThickness" type="number" min="0.2" max="1" step="0.1" /></label>
      </fieldset>
    </details>
    <div class="actions">
      <button :disabled="!canAdd" @click="add">Insert one dart</button>
      <button :disabled="!canChange || !darts.length" @click="remove(false)">Remove oldest</button>
      <button :disabled="!canChange || !darts.length" @click="remove(true)">Remove all</button>
      <button :disabled="!available || !!session || configuring" @click="demo">Load deterministic preset (preview only)</button>
    </div>
    <div class="actions">
      <button :disabled="!canConfigure" @click="enable">{{ configuring ? 'Configuring…' : 'Enable detection · clear scene & configure' }}</button>
      <button :disabled="!canConfigure" @click="enable">Reset playground · clear scene & configure empty</button>
            <button :disabled="!session && !configuring" @click="disarm('Uploads intentionally stopped; scene retained. A later stream stall is expected. No takeout requested.')">Stop uploads</button>
            <button :disabled="!firstFault" @click="exportCapture">Export first failure JSON</button>
            <button :disabled="!firstFault || !!session || configuring" @click="discardCapture">Discard captured failure</button>
    </div>
    <p role="status">{{ message }}</p>
        <p class="hint">Reset is explicit: it clears prior scene occupancy and adopts an empty baseline without undoing scores or emitting takeout.
          Safety guards remain active; wait for fresh stable frames. First-failure capture stays frozen across reset until discarded.
          Export contains recent submitted images and offline scene truth; review before sharing. Memory only, no automatic disk persistence.</p>
    <details>
      <summary>Load reviewed tuning parameters (explicit startup only)</summary>
      <p class="hint">Export only <code>selected.parameters</code> from the tuner artifact to a plain candidate JSON;
        review the held-out evaluation first. Stop the existing detector (including the desktop-managed process), then start:</p>
      <pre>python3 services/detector/main.py --source rendered --parameters build/rendered-benchmark/candidate.json --port 8091</pre>
      <p class="hint">Use the browser dev stack with Native detector URL http://127.0.0.1:8091, apply that source,
        start detection, then enable uploads here. The path is relative to the repository root. Without --parameters the service uses defaults.
        No browser toggle loads parameters and no candidate is automatically promoted. Full export/evaluation commands: services/detector/README.md.</p>
    </details>
    <details>
      <summary>Detector reconstruction diagnostics</summary>
      <p class="hint">Render session: {{ snapshot?.renderSession ?? 'not configured' }} · state: {{ snapshot?.status ?? 'Starting' }}.
        These are detector results, never scene truth sent to the detector.</p>
      <pre>{{ diagnosticText }}</pre>
    </details>
    <p class="hint">{{ darts.length }} scene darts · {{ session ? `capture enabled · acknowledged sequence ${ack}` : 'capture disabled' }}.
      About 5 frame batches/second, one request in flight. Configure always uses an empty reference and resets the baseline
      without scoring. Wait for stable Throw and adopted baseline between insertions. Removal uses image changes only;
      closing settings, stopping uploads or detector faults never request physical takeout.</p>
  </section>
</template>

<style scoped>
.rig-panel { border-top: 1px solid #333b49; padding-top: 1rem; margin-top: 1rem; }
h3, legend, summary { font-size: 0.85rem; }
.hint, figcaption { color: #9aa3b1; font-size: 0.8rem; line-height: 1.45; }
.bad { color: #ef8079; }
figure { margin: 0 0 0.8rem; min-width: 0; }
canvas { display: block; width: 100%; aspect-ratio: 16 / 9; background: #222; }
.overview { max-width: 640px; } .overview canvas { touch-action: none; }
.camera-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.6rem; }
fieldset { display: flex; flex-wrap: wrap; gap: 0.6rem; border: 1px solid #333b49; margin: 0.8rem 0; }
label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; }
input, select { width: 7rem; padding: 0.35rem; background: #0f1216; color: #e8e6e1; border: 1px solid #333b49; border-radius: 5px; }
select { width: 9rem; } .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.7rem 0; }
button { padding: 0.5rem; background: #232936; color: #e8e6e1; border: 1px solid #333b49; border-radius: 6px; }
button:disabled { opacity: 0.45; }
pre { max-height: 16rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.75rem; }
</style>
