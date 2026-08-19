<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, pushToast, type Settings, type SourceConfig } from '../store.ts';

const settings = ref<Settings | null>(null);
const busy = ref(false);
const recomputing = ref(false);
const result = ref<string | null>(null);

// -- bridge source ---------------------------------------------------------

const kind = ref<'simulator' | 'autodarts' | 'replay'>('simulator');
const scheme = ref<'http' | 'https'>('http');
const host = ref('192.168.120.40');
const port = ref(3180);
const debugMotion = ref(false);
const replayFile = ref('recon/captures/live.ndjson');
const replaySpeed = ref(1);
const replayLoop = ref(false);

const applying = ref(false);
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);

const boardUrl = computed(() => `${scheme.value}://${host.value}:${port.value}`);

/** What the bridge is running right now, as opposed to what is on screen. */
const liveDescription = computed(() => settings.value?.bridge?.description ?? 'unknown');

const dirty = computed(() => {
  const live = settings.value?.bridge?.config;
  if (!live) return true;
  const next = buildConfig();
  return JSON.stringify(live) !== JSON.stringify(next);
});

function buildConfig(): SourceConfig {
  if (kind.value === 'autodarts') {
    return { kind: 'autodarts', url: boardUrl.value, debugMotion: debugMotion.value };
  }
  if (kind.value === 'replay') {
    return { kind: 'replay', file: replayFile.value, speed: replaySpeed.value, loop: replayLoop.value };
  }
  return { kind: 'simulator' };
}

/** Seed the form from whatever the bridge is currently running. */
function loadFromConfig(config: SourceConfig | undefined | null): void {
  if (!config) return;
  kind.value = config.kind;
  if (config.kind === 'autodarts') {
    try {
      const parsed = new URL(config.url);
      scheme.value = parsed.protocol === 'https:' ? 'https' : 'http';
      host.value = parsed.hostname;
      port.value = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    } catch {
      // Leave the defaults in place if the stored url is unparseable.
    }
    debugMotion.value = config.debugMotion ?? false;
  }
  if (config.kind === 'replay') {
    replayFile.value = config.file;
    replaySpeed.value = config.speed ?? 1;
    replayLoop.value = config.loop ?? false;
  }
}

async function refresh(): Promise<void> {
  settings.value = await api.settings();
  loadFromConfig(settings.value?.bridge?.config);
}

onMounted(refresh);

watch(kind, () => { testResult.value = null; });

async function testBoard(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  try {
    const r = await api.testBoard(boardUrl.value);
    testResult.value = r.ok
      ? { ok: true, text: `Reachable — Board Manager ${r.version ?? '?'} (${r.latencyMs}ms)` }
      : { ok: false, text: r.error ?? 'unreachable' };
  } catch (err) {
    testResult.value = { ok: false, text: (err as Error).message };
  } finally {
    testing.value = false;
  }
}

async function applySource(): Promise<void> {
  applying.value = true;
  try {
    await api.setBridgeSource(buildConfig());
    await refresh();
    pushToast('Source switched', liveDescription.value, '\u{1F50C}');
  } catch (err) {
    pushToast('Could not switch source', (err as Error).message, '\u{26A0}');
  } finally {
    applying.value = false;
  }
}

async function save(patch: Partial<Settings>): Promise<void> {
  busy.value = true;
  try {
    await api.saveSettings(patch);
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function recompute(): Promise<void> {
  recomputing.value = true;
  result.value = null;
  try {
    const r = await api.recompute();
    result.value =
      `Rebuilt ${r.matches} matches for ${r.profiles} players. ` +
      `${r.unlocked} achievement unlocks recorded.`;
    pushToast('Backfill complete', result.value, '\u{2705}');
  } catch (err) {
    result.value = (err as Error).message;
  } finally {
    recomputing.value = false;
  }
}

async function toggleCoords(value: boolean): Promise<void> {
  await save({ coordsEnabled: value });
  // Coordinate achievements evaluate over stored history, so turning them on
  // only takes effect once the projections are rebuilt.
  await recompute();
}
</script>

<template>
  <section v-if="settings" class="settings">
    <h2>Settings</h2>

    <div class="group">
      <h3>Dart source</h3>
      <p class="hint">
        Switches the bridge while everything is running &mdash; no restart. The
        choice is stored here, so it survives a restart of either the server or
        the bridge.
      </p>

      <p class="live">
        Currently running: <b>{{ liveDescription }}</b>
        <span v-if="!settings.bridge" class="bad">&mdash; bridge unreachable</span>
      </p>

      <div class="tabs">
        <button
          v-for="k in (['simulator', 'autodarts', 'replay'] as const)"
          :key="k"
          :class="{ on: kind === k }"
          @click="kind = k"
        >{{ k === 'autodarts' ? 'Real board' : k === 'simulator' ? 'Simulator' : 'Replay' }}</button>
      </div>

      <p v-if="kind === 'simulator'" class="hint">
        Darts come from the virtual board on the play screen.
      </p>

      <template v-else-if="kind === 'autodarts'">
        <div class="addr">
          <select v-model="scheme">
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
          <input v-model="host" placeholder="192.168.120.40" autocomplete="off" data-1p-ignore />
          <span class="colon">:</span>
          <input v-model.number="port" type="number" min="1" max="65535" class="port" />
        </div>
        <p class="hint url">{{ boardUrl }}</p>

        <label class="toggle">
          <input type="checkbox" v-model="debugMotion" />
          <span>Forward the camera motion channel (~30/s, debugging only)</span>
        </label>

        <div class="actions">
          <button class="secondary" :disabled="testing" @click="testBoard">
            {{ testing ? 'Testing…' : 'Test connection' }}
          </button>
        </div>
        <p v-if="testResult" class="result" :class="{ bad: !testResult.ok }">
          {{ testResult.text }}
        </p>
      </template>

      <template v-else>
        <label class="row wide">
          <span>Capture file</span>
          <input v-model="replayFile" autocomplete="off" data-1p-ignore />
        </label>
        <label class="row">
          <span>Speed</span>
          <input v-model.number="replaySpeed" type="number" min="0.1" max="100" step="0.5" />
        </label>
        <label class="toggle">
          <input type="checkbox" v-model="replayLoop" />
          <span>Loop the capture</span>
        </label>
      </template>

      <div class="actions">
        <button class="primary" :disabled="applying || !dirty" @click="applySource">
          {{ applying ? 'Switching…' : dirty ? 'Apply' : 'Applied' }}
        </button>
      </div>
    </div>

    <div class="group">
      <h3>Celebrations</h3>
      <label class="toggle">
        <input
          type="checkbox"
          :checked="settings.celebrations"
          :disabled="busy"
          @change="save({ celebrations: ($event.target as HTMLInputElement).checked })"
        />
        <span>Full-screen celebration when an achievement unlocks</span>
      </label>
      <label class="row">
        <span>Seconds on screen</span>
        <input
          type="number" min="1" max="30"
          :value="settings.celebrationSeconds"
          :disabled="busy || !settings.celebrations"
          @change="save({ celebrationSeconds: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>
    </div>

    <div class="group">
      <h3>Dart coordinates</h3>
      <p class="hint">
        The board reports a position for each dart, but its units and origin are
        not yet established, so achievements that depend on it stay off. Nothing
        is lost by waiting &mdash; they evaluate over stored history, so enabling
        them later unlocks them retroactively.
      </p>
      <label class="toggle">
        <input
          type="checkbox"
          :checked="settings.coordsEnabled"
          :disabled="busy || recomputing"
          @change="toggleCoords(($event.target as HTMLInputElement).checked)"
        />
        <span>Enable coordinate-based achievements</span>
      </label>
    </div>

    <div class="group">
      <h3>Data</h3>
      <p class="hint">
        Every match is stored as its command log. Statistics and achievements are
        derived from it, so they can always be rebuilt &mdash; run this after
        adding a new achievement or correcting a statistic.
      </p>
      <button class="secondary" :disabled="recomputing" @click="recompute">
        {{ recomputing ? 'Rebuilding…' : 'Rebuild statistics and achievements' }}
      </button>
      <p v-if="result" class="result">{{ result }}</p>
    </div>

    <div class="group">
      <h3>Connection</h3>
      <dl class="runtime">
        <dt>Bridge</dt><dd>{{ settings.runtime.bridgeWs }}</dd>
        <dt>Database</dt><dd>{{ settings.runtime.dbFile }}</dd>
        <dt>Board status</dt>
        <dd :class="settings.runtime.boardOnline ? 'ok' : 'bad'">
          {{ settings.runtime.boardOnline ? 'online' : 'offline' }}
        </dd>
      </dl>
      <p class="hint">
        The bridge address and database path come from the environment; change
        them in <code>.env</code> and restart the stack.
      </p>
    </div>
  </section>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 1.25rem; max-width: 42rem; }
h2 { margin: 0; font-size: 1.1rem; }
h3 { margin: 0 0 0.5rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: #8b93a1; }
.group { border: 1px solid #262b33; border-radius: 10px; padding: 0.9rem 1rem; background: #14171c; }
.hint { margin: 0 0 0.7rem; font-size: 0.82rem; color: #8b93a1; line-height: 1.45; }
.toggle { display: flex; gap: 0.6rem; align-items: flex-start; cursor: pointer; }
.toggle input { margin-top: 0.2rem; }
.row { display: flex; gap: 0.75rem; align-items: center; margin-top: 0.6rem; font-size: 0.9rem; }
.row input { width: 5rem; }
input[type='number'] {
  background: #0f1216; border: 1px solid #262b33; color: #e8e6e1;
  border-radius: 6px; padding: 0.35rem 0.5rem; font: inherit;
}
.secondary {
  background: #232936; border: 1px solid #333b49; color: #e8e6e1;
  border-radius: 8px; padding: 0.55rem 1rem; cursor: pointer; font: inherit;
}
.secondary:disabled { opacity: 0.5; cursor: not-allowed; }
.result { margin: 0.6rem 0 0; font-size: 0.82rem; color: #3f9d54; }
.result.bad { color: #d8453f; }
.live { margin: 0 0 0.7rem; font-size: 0.85rem; color: #b9c0cc; }
.live .bad { color: #d8453f; }
.tabs { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.7rem; }
.tabs button {
  background: #0f1216; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 999px; padding: 0.35rem 0.9rem; cursor: pointer; font: inherit;
}
.tabs button.on { background: #2b3240; border-color: #4f8ef7; color: #fff; }
.addr { display: flex; gap: 0.4rem; align-items: center; }
.addr input {
  flex: 1 1 8rem; background: #0f1216; border: 1px solid #262b33;
  color: #e8e6e1; border-radius: 6px; padding: 0.4rem 0.55rem; font: inherit;
}
.addr input.port { flex: 0 0 6rem; }
.addr select {
  background: #0f1216; border: 1px solid #262b33; color: #e8e6e1;
  border-radius: 6px; padding: 0.4rem 0.5rem; font: inherit;
}
.colon { color: #8b93a1; }
.hint.url { font-family: ui-monospace, monospace; margin-top: 0.35rem; }
.row.wide input { flex: 1; width: auto; }
.row input[type='text'], .row input:not([type]) {
  flex: 1; background: #0f1216; border: 1px solid #262b33; color: #e8e6e1;
  border-radius: 6px; padding: 0.35rem 0.55rem; font: inherit;
}
.actions { display: flex; gap: 0.5rem; margin-top: 0.7rem; }
.primary {
  background: #4f8ef7; border: none; color: #fff; font-weight: 600;
  border-radius: 8px; padding: 0.55rem 1.1rem; cursor: pointer; font: inherit;
}
.primary:disabled { opacity: 0.45; cursor: not-allowed; }
.runtime { display: grid; grid-template-columns: auto 1fr; gap: 0.3rem 1rem; margin: 0 0 0.7rem; font-size: 0.85rem; }
dt { color: #8b93a1; }
dd { margin: 0; font-family: ui-monospace, monospace; font-size: 0.8rem; word-break: break-all; }
dd.ok { color: #3f9d54; font-family: inherit; }
dd.bad { color: #d8453f; font-family: inherit; }
code { font-family: ui-monospace, monospace; background: #0f1216; padding: 0.05rem 0.3rem; border-radius: 3px; }
</style>
