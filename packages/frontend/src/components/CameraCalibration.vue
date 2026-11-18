<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../store.ts';

type Camera = 'cam0' | 'cam1' | 'cam2';
type Point = [number, number];
const cameras: Camera[] = ['cam0', 'cam1', 'cam2'];
const labels = ['Bull centre', 'Outer double wire: left edge of 20', 'Outer double wire: right edge of 20',
  'Outer double wire: upper edge of 6', 'Outer double wire: lower edge of 6',
  'Outer double wire: right edge of 3', 'Outer double wire: left edge of 3',
  'Outer double wire: lower edge of 11', 'Outer double wire: upper edge of 11'];
const points = ref<Record<Camera, Point[]>>({ cam0: [], cam1: [], cam2: [] });
const selected = ref<Camera>('cam0');
const frozen = ref<{ token: string; width: number; height: number } | null>(null);
const busy = ref(false);
const message = ref('');
const manualX = ref<number | null>(null);
const manualY = ref<number | null>(null);
const draft = ref<Point | null>(null);
const landmarkAngles = [0, -99, -81, -9, 9, 81, 99, 171, 189];
const guidePoint = computed(() => {
  const i = points.value[selected.value].length;
  const angle = (landmarkAngles[i] ?? 0) * Math.PI / 180;
  return i === 0 ? [100, 100] : [100 + 80 * Math.cos(angle), 100 + 80 * Math.sin(angle)];
});
const errors = ref<Record<Camera, number> | null>(null);
const complete = computed(() => cameras.every(id => points.value[id].length === labels.length));

async function freeze(): Promise<void> {
  busy.value = true; message.value = ''; errors.value = null; frozen.value = null;
  try {
    const stopped = await api.boardAction('stop');
    if (!stopped.ok) throw new Error(stopped.error ?? 'Could not stop detection');
    const response = await fetch('/api/native/calibration/freeze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not capture cameras');
    if (typeof data.token !== 'string' || !Number.isInteger(data.width) || !Number.isInteger(data.height)) throw new Error('Invalid capture response');
    frozen.value = data;
    points.value = { cam0: [], cam1: [], cam2: [] };
    selected.value = 'cam0'; draft.value = null;
  } catch (error) { message.value = (error as Error).message; }
  finally { busy.value = false; }
}
function mark(event: MouseEvent): void {
  if (!frozen.value || points.value[selected.value].length >= labels.length) return;
  const svg = event.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = (event.clientX - rect.left) / rect.width * frozen.value.width;
  const y = (event.clientY - rect.top) / rect.height * frozen.value.height;
  if (x >= 0 && y >= 0 && x < frozen.value.width && y < frozen.value.height) draft.value = [x, y];
}
function addCoordinates(): void {
  if (!frozen.value || manualX.value === null || manualY.value === null ||
      !Number.isFinite(manualX.value) || !Number.isFinite(manualY.value) ||
      manualX.value < 0 || manualY.value < 0 || manualX.value >= frozen.value.width ||
      manualY.value >= frozen.value.height || points.value[selected.value].length >= labels.length) return;
  draft.value = [manualX.value, manualY.value];
  manualX.value = null; manualY.value = null;
}
function adjust(dx: number, dy: number): void {
  if (!draft.value || !frozen.value) return;
  draft.value = [Math.max(0, Math.min(frozen.value.width - 1, draft.value[0] + dx)),
    Math.max(0, Math.min(frozen.value.height - 1, draft.value[1] + dy))];
}
function confirmPoint(): void {
  if (!draft.value) return;
  points.value[selected.value].push(draft.value);
  draft.value = null;
}
async function apply(): Promise<void> {
  if (!frozen.value || !complete.value) return;
  busy.value = true; message.value = '';
  try {
    const response = await fetch('/api/native/calibration/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: frozen.value.token, landmarks: points.value }),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error(data.error ?? 'Calibration failed');
    errors.value = data.rms;
    frozen.value = null;
    message.value = 'Calibration saved and applied. Detection remains stopped; check the fit and start detection when ready.';
  } catch (error) { message.value = (error as Error).message; }
  finally { busy.value = false; }
}
</script>

<template>
  <details class="calibration">
    <summary>Calibrate USB cameras</summary>
    <p>Remove all darts and hands, keep the board and lights still, then capture all three cameras. Detection stops during calibration. A reset or calibration does not correct match scores.</p>
    <p>Camera geometry is estimated from the selected points. Lens distortion can affect scoring accuracy.</p>
    <button class="secondary" :disabled="busy" @click="freeze">{{ frozen ? 'Capture new images' : 'Stop detection and capture images' }}</button>
    <template v-if="frozen">
      <div class="camera-tabs">
        <button v-for="id in cameras" :key="id" class="secondary" :aria-pressed="selected === id" @click="selected = id; draft = null">{{ id }} · {{ points[id].length }}/9</button>
      </div>
      <p v-if="points[selected].length < 9">Click {{ points[selected].length + 1 }} of 9: <strong>{{ labels[points[selected].length] }}</strong></p>
      <p v-else>All points selected for {{ selected }}. Check their positions, then select the next camera.</p>
      <svg v-if="points[selected].length < 9" class="guide" viewBox="0 0 200 200" role="img" :aria-label="`Board diagram showing ${labels[points[selected].length]}`">
        <circle cx="100" cy="100" r="80" fill="#254c3a" stroke="white" stroke-width="2" />
        <circle cx="100" cy="100" r="72" fill="#242424" stroke="white" />
        <circle cx="100" cy="100" r="48" fill="none" stroke="#a83b3b" stroke-width="8" />
        <circle cx="100" cy="100" r="5" fill="#e25c4b" />
        <path v-for="angle in landmarkAngles.slice(1)" :key="angle" :d="`M 100 100 L ${100 + 80 * Math.cos(angle * Math.PI / 180)} ${100 + 80 * Math.sin(angle * Math.PI / 180)}`" stroke="#aaa" stroke-width="1" />
        <text x="100" y="14" text-anchor="middle" fill="white">20</text><text x="190" y="104" text-anchor="middle" fill="white">6</text>
        <text x="100" y="195" text-anchor="middle" fill="white">3</text><text x="10" y="104" text-anchor="middle" fill="white">11</text>
        <circle :cx="guidePoint[0]" :cy="guidePoint[1]" r="6" fill="#ffdc54" stroke="#000" stroke-width="2" />
      </svg>
      <svg class="frame" :viewBox="`0 0 ${frozen.width} ${frozen.height}`" role="img" :aria-label="`${selected} calibration image; select the requested board landmark`" @click="mark">
        <image :href="`/api/native/calibration/frame/${selected}?snapshot=${frozen.token}`" :width="frozen.width" :height="frozen.height" />
        <g v-for="(point, index) in points[selected]" :key="index">
          <circle :cx="point[0]" :cy="point[1]" r="7" fill="none" stroke="#ffdc54" stroke-width="2" />
          <text :x="point[0] + 8" :y="point[1] - 5" fill="#ffdc54" stroke="#000" stroke-width="2" paint-order="stroke" font-size="16">{{ index + 1 }}</text>
        </g>
      </svg>
      <template v-if="draft">
        <p>Fine adjust the selected point, then confirm it.</p>
        <svg class="zoom" :viewBox="`${draft[0] - 30} ${draft[1] - 30} 60 60`" role="img" aria-label="Magnified selected point">
          <image :href="`/api/native/calibration/frame/${selected}?snapshot=${frozen.token}`" :width="frozen.width" :height="frozen.height" />
          <path :d="`M ${draft[0] - 5} ${draft[1]} h 10 M ${draft[0]} ${draft[1] - 5} v 10`" stroke="#ffdc54" stroke-width="0.6" />
        </svg>
        <div class="camera-tabs">
          <button class="secondary" aria-label="Move point left" @click="adjust(-1, 0)">←</button>
          <button class="secondary" aria-label="Move point up" @click="adjust(0, -1)">↑</button>
          <button class="secondary" aria-label="Move point down" @click="adjust(0, 1)">↓</button>
          <button class="secondary" aria-label="Move point right" @click="adjust(1, 0)">→</button>
          <button class="secondary" @click="confirmPoint">Confirm point</button>
          <button class="secondary" @click="draft = null">Cancel selection</button>
        </div>
      </template>
      <div class="camera-tabs">
        <label>Pixel X <input v-model.number="manualX" type="number" min="0" :max="frozen.width - 1" /></label>
        <label>Pixel Y <input v-model.number="manualY" type="number" min="0" :max="frozen.height - 1" /></label>
        <button class="secondary" :disabled="busy || points[selected].length >= 9" @click="addCoordinates">Select point by coordinates</button>
      </div>
      <div class="camera-tabs">
        <button class="secondary" :disabled="!points[selected].length || busy" @click="points[selected].pop()">Undo last point</button>
        <button class="secondary" :disabled="!complete || busy" @click="apply">Validate, save and apply calibration</button>
      </div>
      <p>Use the intersection of the outer edge of the double ring and the wire separating the named numbers. All nine landmarks must be visible in each view.</p>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="errors">Board-point fit (RMS): {{ cameras.map(id => `${id} ${errors![id].toFixed(1)} px`).join(' · ') }}. This is not a measurement of off-board shaft accuracy.</p>
  </details>
</template>

<style scoped>
.calibration { margin: 1rem 0; }
.frame { display: block; width: 100%; max-width: 800px; height: auto; cursor: crosshair; background: #111; touch-action: manipulation; }
.guide { display: block; width: 160px; height: 160px; margin: .5rem 0; background: #111; }
.zoom { display: block; width: 240px; max-width: 100%; background: #111; image-rendering: pixelated; }
.camera-tabs { display: flex; flex-wrap: wrap; gap: .5rem; margin: .75rem 0; }
button[aria-pressed="true"] { outline: 2px solid currentColor; }
</style>
