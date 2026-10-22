<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue';
const CameraRig3D = defineAsyncComponent(() => import('./CameraRig3D.vue'));
import { api } from '../store.ts';
import { nativeFrameUrl, parseNativeState, validImpact, validRemoveCount, type NativeState } from '../nativeDetector.ts';

const snapshot = ref<NativeState | null>(null);
const error = ref<string | null>(null);
const commandResult = ref<string | null>(null);
const health = ref(false);
const busy = ref(false);
const x = ref<number | string>(0);
const y = ref<number | string>(102);
const count = ref<number | string>(1);
const revision = ref(0);
const failedFrames = ref<Record<string, boolean>>({});
const synthetic = computed(() => snapshot.value?.source === 'synthetic');
const ready = computed(() => synthetic.value && snapshot.value?.running && snapshot.value.status === 'Throw' &&
  !snapshot.value.pending.adoptingBaseline && snapshot.value.faults.length === 0 &&
  snapshot.value.pending.stableFrames >= snapshot.value.pending.requiredFrames &&
  snapshot.value.cameras.every(camera => camera.available && camera.calibrated));
let stopped = false;
let commandRevision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let commandController: AbortController | undefined;

async function refresh(): Promise<void> {
  const currentCommand = commandRevision;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 4000);
  try {
    const [live, raw] = await Promise.all([api.nativeHealth(controller.signal), api.nativeState(controller.signal)]);
    if (stopped || busy.value || currentCommand !== commandRevision) return;
    const state = parseNativeState(raw);
    if (!live || typeof live !== 'object' || !('ok' in live) || live.ok !== true ||
        !('session' in live) || live.session !== state.session) throw new Error('Invalid detector health or session changed; retrying');
    health.value = true;
    snapshot.value = state;
    revision.value++;
    failedFrames.value = {};
    error.value = null;
  } catch (err) {
    if (stopped) return;
    health.value = false;
    snapshot.value = null;
    error.value = (err as Error).message;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (!stopped) timer = setTimeout(poll, 2000);
  }
}
function poll(): void {
  if (document.hidden) {
    snapshot.value = null;
    timer = setTimeout(poll, 2000);
  } else void refresh();
}

async function simulate(action: 'throw' | 'takeout' | 'reset', all = false): Promise<void> {
  if (!synthetic.value || busy.value) return;
  if (action === 'throw' && (!ready.value || !validImpact(x.value, y.value))) return;
  if (action === 'takeout' && !all && !validRemoveCount(count.value)) return;
  busy.value = true;
  commandRevision++;
  commandResult.value = null;
  commandController = new AbortController();
  const timeout = setTimeout(() => commandController?.abort(), 4000);
  try {
    const body = action === 'throw' ? { x_mm: Number(x.value), y_mm: Number(y.value) }
      : action === 'takeout' && !all ? { count: Number(count.value) } : {};
    const result = await api.nativeSim(action, body, commandController.signal);
    if (!result || result.ok !== true) throw new Error(result?.error ?? 'Malformed simulator response');
    commandResult.value = action === 'reset' ? 'Images cleared and baseline reset; no takeout events emitted.'
      : 'Image change requested. Wait for stable detection before the next change.';
    // Do not allow another impact using the pre-command snapshot.
    snapshot.value = null;
  } catch (err) {
    commandResult.value = `Simulation failed: ${(err as Error).message}. Refreshing state; do not blindly retry a timed-out throw.`;
    snapshot.value = null;
  } finally {
    clearTimeout(timeout);
    commandRevision++;
    busy.value = false;
  }
}

onMounted(poll);
onUnmounted(() => {
  stopped = true;
  clearTimeout(timer);
  controller?.abort();
  commandController?.abort();
});
</script>

<template>
  <div class="group">
    <h3>Native detector · camera diagnostics</h3>
    <p class="hint">
      Experimental image proof-of-pipeline, not a production dart detector. No live camera acquisition,
      automatic calibration or hardware accuracy is claimed. Image replay is also supported.
      No browser camera permission is needed. Previews and controls use the server proxy only.
    </p>
    <p v-if="error" class="bad" role="status">Detector unavailable: {{ error }}</p>
    <template v-if="snapshot">
      <p>Process {{ health ? 'alive' : 'unavailable' }} · {{ snapshot.source }} · {{ snapshot.status }} ·
        {{ snapshot.running ? 'armed' : 'stopped' }} · {{ snapshot.occupancy }} detected darts</p>
      <p class="hint">Stable frames: {{ snapshot.pending.stableFrames }}/{{ snapshot.pending.requiredFrames }} ·
        {{ snapshot.pending.adoptingBaseline ? 'adopting baseline — wait' : 'baseline adopted' }}</p>
      <ul v-if="snapshot.faults.length" class="bad"><li v-for="fault in snapshot.faults" :key="fault">{{ fault }}</li></ul>
      <div class="cameras">
        <figure v-for="camera in snapshot.cameras" :key="camera.id">
          <img v-if="camera.available" :src="nativeFrameUrl(camera.id, revision)" :alt="`${camera.id} detector image`"
            referrerpolicy="no-referrer" @error="failedFrames[camera.id] = true" />
          <figcaption>{{ camera.id }} · {{ camera.calibrated ? 'calibrated' : 'uncalibrated' }}
            <span v-if="!camera.available || failedFrames[camera.id]" class="bad"> · frame unavailable</span>
          </figcaption>
        </figure>
      </div>
      <div v-if="synthetic" class="synthetic">
        <h3>Synthetic image simulator</h3>
        <p class="hint">Adds markers to camera IMAGES, not injected throws or predetermined scores.
          Origin is the bull; millimetres, x right and y up, each axis −200 to 200.
          Wait for Throw and an adopted baseline between impacts. Overlapping markers may fault.</p>
        <div class="controls">
          <label>X (mm) <input v-model.number="x" type="number" min="-200" max="200" step="0.1" /></label>
          <label>Y (mm) <input v-model.number="y" type="number" min="-200" max="200" step="0.1" /></label>
          <button :disabled="busy || !ready || !validImpact(x, y)" @click="simulate('throw')">Add image dart</button>
        </div>
        <div class="controls">
          <label>Remove count <input v-model.number="count" type="number" min="1" step="1" /></label>
          <button :disabled="busy || !validRemoveCount(count)" @click="simulate('takeout')">Remove oldest</button>
          <button :disabled="busy" @click="simulate('takeout', true)">Remove all</button>
          <button :disabled="busy" @click="simulate('reset')">Reset simulator</button>
        </div>
        <p class="hint">Partial removal starts takeout; completion waits until all views are empty.
          Reset simulator clears images and adopts a baseline without takeout events.</p>
      </div>
      <CameraRig3D v-else-if="snapshot.source === 'rendered'" :snapshot="snapshot" />
      <p v-else class="hint">Image replay source: synthetic controls unavailable. For the 3D simulator,
        restart the detector service with source rendered; source is startup configuration, not a browser toggle.</p>
    </template>
    <p v-else-if="!error" class="hint">Waiting for detector state…</p>
    <p v-if="commandResult" role="status">{{ commandResult }}</p>
  </div>
</template>

<style scoped>
.group { border: 1px solid #262b33; border-radius: 10px; padding: 0.9rem 1rem; background: #14171c; }
h3 { margin: 0 0 0.5rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: #8b93a1; }
p, figcaption { font-size: 0.82rem; }
.hint { color: #8b93a1; line-height: 1.45; }
.bad { color: #d8453f; }
.cameras { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.6rem; margin-bottom: 1rem; }
figure { margin: 0; min-width: 0; }
img { width: 100%; aspect-ratio: 1; object-fit: contain; background: #0f1216; }
.controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.7rem; }
label { font-size: 0.82rem; }
input { width: 5rem; background: #0f1216; border: 1px solid #262b33; color: #e8e6e1; border-radius: 6px; padding: 0.35rem; }
button { background: #232936; border: 1px solid #333b49; color: #e8e6e1; border-radius: 8px; padding: 0.5rem; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
