<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, type DeepReadonly } from 'vue';
import type { BullOffCommand, BullOffView, Coords, Segment } from '@darts/schema';
import { api, store } from '../store.ts';
import Dartboard from './Dartboard.vue';
import PlayerAvatar from './PlayerAvatar.vue';

const props = defineProps<{ session: DeepReadonly<BullOffView>; applying?: boolean }>();
const emit = defineEmits<{ (e: 'finish', id: string): void }>();
const sheet = ref<HTMLElement | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const distance = ref<number | null>(null);
const active = computed(() => props.session.players.find(p => p.id === props.session.activePlayerId));
const ready = computed(() => !busy.value && !props.applying && store.connected);
const canThrow = computed(() => ready.value && !props.session.complete && !props.session.awaitingTakeout);
const validDistance = computed(() => distance.value !== null && Number.isFinite(distance.value) && distance.value >= 0 && distance.value <= 225);
const marks = computed(() => {
  const result = props.session.results[props.session.activePlayerId ?? ''];
  return props.session.awaitingTakeout && result ? [{ label: result.label, coords: result.coords }] : [];
});
const priorFocus = document.activeElement as HTMLElement | null;
onMounted(() => sheet.value?.focus());
onUnmounted(() => { if (priorFocus?.isConnected) priorFocus.focus(); });

async function act(command: BullOffCommand): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await api.bullOffCommand(props.session.id, command);
    distance.value = null;
  } catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

async function simulate(payload: { segment: Segment; coords: Coords }): Promise<void> {
  if (!canThrow.value) return;
  busy.value = true;
  error.value = null;
  try { await api.simulate(payload.segment, payload.coords); }
  catch (err) { error.value = (err as Error).message; }
  finally { busy.value = false; }
}

async function trapFocus(event: KeyboardEvent): Promise<void> {
  if (event.key !== 'Tab') return;
  const controls = sheet.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary');
  if (!controls?.length) return;
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.value)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); await nextTick(); first.focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="bull-off-overlay">
      <section ref="sheet" class="bull-off" role="dialog" aria-modal="true" aria-labelledby="bull-off-title" tabindex="-1" @keydown="trapFocus" @keydown.esc.prevent="!busy && !applying && act({ type: 'CANCEL' })">
        <header><div><h2 id="bull-off-title">Bull-off</h2><p>One dart each · closest to bull starts</p></div><button :disabled="busy || applying" @click="act({ type: 'CANCEL' })">Cancel</button></header>
        <p v-if="!store.connected" class="error" role="alert">Connection lost. Waiting to reconnect…</p>
        <div class="bull-off-grid">
          <div>
            <p class="turn" aria-live="polite">
              <template v-if="session.complete">Starting order decided</template>
              <template v-else-if="session.awaitingTakeout">{{ active?.name }}: remove your dart{{ session.retry ? ' and try again' : '' }}.</template>
              <template v-else><PlayerAvatar v-if="active" :player-id="active.id" />{{ active?.name }}, throw for bull<span v-if="session.round > 1"> · tie-break {{ session.round - 1 }}</span></template>
            </p>
            <ol aria-label="Bull-off standings">
              <template v-for="(group, rank) in session.groups" :key="group.join(',')">
                <li v-for="id in group" :key="id" :class="{ active: session.activePlayerId === id }" :style="{ '--player': session.players.find(p => p.id === id)?.color }">
                  <span class="place">{{ 1 + session.groups.slice(0, rank).reduce((sum, ids) => sum + ids.length, 0) }}{{ group.length > 1 ? '=' : '.' }}</span>
                  <PlayerAvatar :player-id="id" /><strong>{{ session.players.find(p => p.id === id)?.name }}</strong>
                  <span class="result" v-if="session.results[id]">{{ session.results[id]!.label }}<small v-if="session.results[id]!.distanceMm !== null">{{ session.results[id]!.distanceMm }} mm</small><small v-else-if="session.results[id]!.band > 1">No distance</small></span>
                  <span v-else class="result">—</span>
                </li>
              </template>
            </ol>
            <p class="hint">Inner bull beats outer bull. Equal bull rings or indistinguishable hits are rethrown in reverse order; only tied players throw again.</p>
            <div class="actions">
              <button :disabled="!ready || !session.canUndo" @click="act({ type: 'UNDO' })">Undo last dart</button>
              <button :disabled="!ready" @click="act({ type: 'RESTART' })">Restart bull-off</button>
              <button v-if="session.awaitingTakeout" :disabled="!ready" @click="act({ type: 'NEXT' })">Dart removed</button>
            </div>
            <form v-if="!session.complete" @submit.prevent="canThrow && validDistance && act({ type: 'MEASURE', distanceMm: distance! })">
              <label for="bull-off-distance">Enter measured distance instead (mm)</label>
              <div class="measurement"><input id="bull-off-distance" v-model.number="distance" type="number" min="0" max="225" step="0.1" :disabled="!canThrow" /><button type="submit" :disabled="!canThrow || !validDistance">Record distance</button></div>
              <p class="hint">Without coordinates, hits in the same zone tie. Undo a detected dart to replace it with a measurement. Bull-off darts do not count towards scores or statistics.</p>
            </form>
            <p v-if="error" class="error" role="alert">{{ error }}</p>
            <button v-if="session.complete" class="primary" :disabled="!ready" @click="emit('finish', session.id)">Use this order</button>
          </div>
          <div class="board-wrap"><Dartboard :highlight-numbers="session.complete ? [] : [25]" :marks="marks" :mark-color="active?.color" @throw="simulate" /><p class="hint">Use your connected board, or click the virtual board when using the simulator. Remove each dart before the next player throws.</p></div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.bull-off-overlay { position: fixed; inset: 0; z-index: 80; background: #040b13e8; overflow-y: auto; padding: 1rem; display: grid; align-items: start; justify-items: center; }
.bull-off { width: min(1040px, 100%); box-sizing: border-box; background: var(--ui-surface-deep); border: 1px solid var(--ui-border); border-radius: 16px; padding: 1rem; color: var(--ui-text); }
header { display: flex; justify-content: space-between; gap: 1rem; align-items: center; margin-bottom: 1rem; }h2, p { margin: 0; }header p, .hint { color: var(--ui-muted); font-size: .82rem; line-height: 1.5; }
.bull-off-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.25rem; }.turn { font-size: 1.2rem; font-weight: 650; min-height: 3rem; }
ol { list-style: none; padding: 0; display: grid; gap: .45rem; }li { display: flex; align-items: center; gap: .5rem; padding: .65rem; border: 2px solid transparent; border-radius: 9px; background: var(--ui-surface); }li.active { border-color: var(--player); }.place { width: 2rem; flex-shrink: 0; }.result { margin-left: auto; text-align: right; }.result small { display: block; color: var(--ui-muted); font-size: .7rem; }li strong { overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: .4rem; margin: .8rem 0; }button, input { font: inherit; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-surface); color: var(--ui-text); padding: .5rem .65rem; }button { cursor: pointer; }button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible, input:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
form { display: grid; gap: .4rem; margin-top: 1rem; }.measurement { display: flex; gap: .4rem; }.measurement input { min-width: 0; width: 8rem; }label { font-size: .85rem; }.primary { background: var(--ui-accent); color: #062337; margin-top: 1rem; font-weight: 700; }.error { color: var(--ui-danger); margin-top: .7rem; }.board-wrap { min-width: 0; }.board-wrap .board { width: 100%; max-height: 65vh; }.board-wrap .hint { text-align: center; }
@media(max-width: 650px) { .bull-off-grid { grid-template-columns: minmax(0, 1fr); }.board-wrap { max-width: 350px; margin-inline: auto; }.bull-off-overlay { padding: .5rem; }.measurement { flex-wrap: wrap; } }
</style>
