<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../store.ts';

const props = defineProps<{ connected: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const devices = ref<string[]>([]);
const selected = ref(['', '', '']);
const busy = ref(false);
const message = ref('');
const openPicker = ref<number | null>(null);
const container = ref<HTMLElement | null>(null);

function dismissOutside(event: PointerEvent): void {
  if (!container.value?.contains(event.target as Node)) openPicker.value = null;
}
function choose(index: number, device: string, event: Event): void {
  selected.value[index] = device;
  openPicker.value = null;
  (event.target as HTMLElement).closest('details')?.querySelector('summary')?.focus();
}
function closePicker(event: KeyboardEvent): void {
  openPicker.value = null;
  (event.target as HTMLElement).closest('details')?.querySelector('summary')?.focus();
}

async function scan(): Promise<void> {
  busy.value = true; message.value = '';
  try {
    const response = await fetch('/api/native/usb/devices', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.devices) || !data.devices.every((d: unknown) => typeof d === 'string')) throw new Error(data.error ?? 'Invalid camera list');
    devices.value = data.devices;
    if (!devices.value.length) message.value = 'No USB camera devices found. Connect the cameras and refresh the list.';
  } catch (error) { message.value = `Could not list cameras: ${(error as Error).message}`; }
  finally { busy.value = false; }
}
async function change(action: 'connect' | 'disconnect'): Promise<void> {
  if (busy.value) return;
  if (action === 'connect' && (selected.value.some(x => !x) || new Set(selected.value).size !== 3)) {
    message.value = 'Select three distinct camera devices.'; return;
  }
  busy.value = true; message.value = '';
  try {
    const stopped = await api.boardAction('stop');
    if (!stopped.ok) throw new Error(stopped.error ?? 'Could not stop detection');
    const response = await fetch(`/api/native/usb/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action === 'connect' ? { devices: selected.value } : {}),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error(data.error ?? 'Camera operation failed');
    message.value = action === 'connect'
      ? 'Cameras connected. Calibrate the board below before starting detection.'
      : 'Cameras disconnected. You can select a new camera order.';
    emit('changed');
  } catch (error) { message.value = `Camera setup failed: ${(error as Error).message}`; }
  finally { busy.value = false; }
}
onMounted(() => {
  document.addEventListener('pointerdown', dismissOutside);
  if (!props.connected) void scan();
});
onUnmounted(() => document.removeEventListener('pointerdown', dismissOutside));
</script>

<template>
  <details ref="container" open class="usb">
    <summary>USB cameras</summary>
    <p>Choose three different cameras in the order you want to calibrate them. Changing cameras stops detection; reconcile any active match first.</p>
    <template v-if="!connected">
      <button class="secondary" :disabled="busy" @click="scan">Refresh camera list</button>
      <div v-for="(_, index) in selected" :key="index" class="device-row">
        <span :id="`camera-label-${index}`" class="device-label">Camera {{ index + 1 }}</span>
        <details class="device-picker" :open="openPicker === index" @keydown.esc.stop.prevent="closePicker">
          <summary :aria-labelledby="`camera-label-${index} camera-value-${index}`" :aria-disabled="busy || !devices.length"
            @click.prevent="!busy && devices.length && (openPicker = openPicker === index ? null : index)">
            <span :id="`camera-value-${index}`" class="device-value" :class="{ placeholder: !selected[index] }">{{ selected[index] || 'Select a device' }}</span>
            <span class="chevron" aria-hidden="true"></span>
          </summary>
          <fieldset class="device-options" :aria-labelledby="`camera-label-${index}`">
            <label v-for="device in devices" :key="device" class="device-option" :class="{ chosen: selected[index] === device }">
              <input type="radio" :name="`usb-camera-${index}`" :value="device" :checked="selected[index] === device"
                :disabled="busy" @change="choose(index, device, $event)" />
              <span>{{ device }}</span>
              <span v-if="selected[index] === device" class="check" aria-hidden="true">✓</span>
            </label>
          </fieldset>
        </details>
      </div>
      <button class="secondary" :disabled="busy || devices.length < 3" @click="change('connect')">{{ busy ? 'Connecting…' : 'Connect cameras' }}</button>
    </template>
    <template v-else>
      <p>USB cameras are connected. Use the calibration panel below to mark the board.</p>
      <button class="secondary" :disabled="busy" @click="change('disconnect')">Disconnect cameras</button>
    </template>
    <p v-if="message" role="status">{{ message }}</p>
  </details>
</template>

<style scoped>
.usb { margin: 1rem 0; }
.device-row { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1rem; margin: .65rem 0; }
.device-label { flex: 0 0 5.5rem; color: var(--ui-secondary); font-size: .82rem; }
.device-picker { position: relative; flex: 1 1 15rem; min-width: 0; max-width: 32rem; }
.device-picker summary { display: flex; align-items: center; justify-content: space-between; gap: .75rem;
  min-height: 2.75rem; padding: .65rem .8rem; border: 1px solid var(--ui-border); border-radius: 9px;
  background: var(--ui-surface-deep); color: var(--ui-text); cursor: pointer; list-style: none; }
.device-picker summary::-webkit-details-marker { display: none; }
.device-picker summary:hover, .device-picker[open] summary { border-color: var(--ui-accent); }
.device-picker summary[aria-disabled="true"] { opacity: .55; cursor: not-allowed; }
.device-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; }
.placeholder { color: var(--ui-muted); }
.chevron { flex: 0 0 auto; width: .5rem; height: .5rem; border-right: 2px solid var(--ui-muted);
  border-bottom: 2px solid var(--ui-muted); transform: rotate(45deg) translateY(-2px); }
.device-picker[open] .chevron { transform: rotate(225deg) translate(-2px, -1px); }
.device-options { position: absolute; z-index: 5; top: calc(100% + .35rem); left: 0; right: 0; max-height: 15rem;
  overflow-y: auto; margin: 0; padding: .3rem; border: 1px solid var(--ui-border); border-radius: 10px;
  background: var(--ui-surface); box-shadow: 0 12px 28px rgb(0 0 0 / 35%); }
.device-option { display: flex; align-items: center; gap: .6rem; padding: .65rem .7rem; border-radius: 7px;
  color: var(--ui-secondary); font-size: .82rem; overflow-wrap: anywhere; cursor: pointer; }
.device-option:hover, .device-option:focus-within { background: var(--ui-surface-raised); color: var(--ui-text); }
.device-option.chosen { color: var(--ui-accent); background: #56cfff12; }
.device-option input { flex: 0 0 auto; margin: 0; accent-color: var(--ui-accent); }
.check { margin-left: auto; color: var(--ui-accent); }
@media (max-width: 520px) { .device-label { flex-basis: 100%; } }
</style>
