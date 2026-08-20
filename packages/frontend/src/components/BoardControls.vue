<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, pushToast, store, type BoardAction, type BoardStateResult } from '../store.ts';

/**
 * The board's own controls, not the game's.
 *
 * Every button here maps to exactly one Board Manager endpoint and nothing
 * else: "stop" stops detection, it does not end a match. Keeping that mapping
 * one-to-one is the point -- it is the panel you reach for when the hardware,
 * rather than the game, is misbehaving.
 *
 * `compact` renders the buttons alone, for the app header: Reset and
 * Calibrate are wanted mid-game, with darts in hand, so they live one press
 * away rather than behind a disclosure. The indicator and the explanatory
 * text are dropped there because the header already carries a board pill --
 * the full panel on the Settings screen is where the explanation belongs.
 */
const props = defineProps<{ compact?: boolean }>();

const result = ref<BoardStateResult | null>(null);
const busy = ref<BoardAction | null>(null);
const error = ref<string | null>(null);

/** Slow poll: this is a status light, not a scoreboard. */
const POLL_MS = 5000;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Two independent signals, and they answer different questions.
 *
 * `store.boardOnline` comes from the bridge's websocket heartbeat -- is the
 * board talking to us. `state.running` comes from the board -- is detection
 * actually armed. A board can be perfectly online and detecting nothing.
 */
const reachable = computed(() => result.value?.ok === true);
const running = computed(() => Boolean(result.value?.state?.running));
const status = computed(() => result.value?.state?.status ?? store.boardStatus);
const numThrows = computed(() => result.value?.state?.numThrows ?? null);

/** No board attached at all -- the source is the simulator or a replay. */
const noBoard = computed(() => result.value?.attached === false);

async function refresh(): Promise<void> {
  try {
    result.value = await api.boardState();
    error.value = result.value.ok ? null : (result.value.error ?? null);
  } catch (err) {
    error.value = (err as Error).message;
    result.value = null;
  }
}

async function run(action: BoardAction): Promise<void> {
  if (action === 'calibrate' && !confirm('Re-run auto-calibration on the board?')) return;
  busy.value = action;
  error.value = null;
  try {
    const r = await api.boardAction(action);
    if (!r.ok) {
      error.value = r.error ?? `the board refused to ${action}`;
      pushToast('Board command failed', error.value, '\u{26A0}');
    } else {
      pushToast('Board', LABELS[action].done, '\u{1F3AF}');
    }
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = null;
    await refresh();
  }
}

const LABELS: Record<BoardAction, { button: string; done: string; title: string }> = {
  start: { button: 'Start', done: 'detection started', title: 'Start dart detection' },
  stop: { button: 'Stop', done: 'detection stopped', title: 'Stop dart detection' },
  reset: { button: 'Reset', done: 'throw counter reset', title: "Reset the board's throw counter" },
  calibrate: {
    button: 'Calibrate',
    done: 'auto-calibration started',
    title: 'Re-run auto-calibration',
  },
};

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="board" :class="{ compact: props.compact }">
    <div v-if="!props.compact" class="indicator">
      <span class="light" :class="{ on: store.boardOnline }" />
      <b>{{ store.boardOnline ? 'Board connected' : 'Board not connected' }}</b>
      <span v-if="reachable" class="chip" :class="{ live: running }">
        {{ running ? 'detecting' : 'idle' }}
      </span>
      <span v-if="status" class="chip">{{ status }}</span>
      <span v-if="numThrows !== null" class="chip">{{ numThrows }} in board</span>
      <button class="link" title="Refresh now" @click="refresh">&#8635;</button>
    </div>

    <div class="actions">
      <button
        v-for="action in (['start', 'stop', 'reset', 'calibrate'] as BoardAction[])"
        :key="action"
        :class="{ danger: action === 'calibrate' }"
        :disabled="busy !== null || noBoard"
        :title="noBoard ? 'No board attached — set one up on the Settings screen' : LABELS[action].title"
        @click="run(action)"
      >
        {{ busy === action ? '…' : LABELS[action].button }}
      </button>
    </div>

    <!--
      The compact form says none of this: a failed command already raises a
      toast, and "why is this greyed out" is answered by the button's own
      tooltip. Prose in the header would push the whole app down a row.
    -->
    <template v-if="!props.compact">
      <p v-if="noBoard" class="hint">
        No board attached &mdash; the bridge is running the simulator or a replay.
        Point it at a board on the Settings screen to use these.
      </p>
      <p v-else-if="error" class="hint bad">{{ error }}</p>
      <p v-else class="hint">
        These call the Board Manager directly. Stopping detection stops darts
        arriving; it does not end the match.
      </p>
    </template>
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 0.5rem; }
.indicator { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.9rem; }
.light {
  width: 0.6rem; height: 0.6rem; border-radius: 50%; flex: none;
  background: #d8453f; box-shadow: 0 0 0.4rem #d8453f88;
}
.light.on { background: #3f9d54; box-shadow: 0 0 0.4rem #3f9d5488; }
.chip {
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
  border: 1px solid #262b33; background: #14171c; color: #8b93a1;
  border-radius: 999px; padding: 0.15rem 0.55rem;
}
.chip.live { border-color: #1f3a2a; background: #16241c; color: #3f9d54; }
.link { background: none; border: none; color: #6b7280; cursor: pointer; font-size: 1rem; padding: 0 0.2rem; }
.link:hover { color: #cdd3dc; }
.actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.actions button {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 6px; padding: 0.4rem 0.85rem; cursor: pointer; font: inherit; font-size: 0.9rem;
}
.actions button:hover:not(:disabled) { border-color: #4f8ef7; }
.actions button.danger { border-color: #45262a; color: #c9645f; }
.actions button.danger:hover:not(:disabled) { border-color: #d8453f; color: #d8453f; }
.actions button:disabled { opacity: 0.4; cursor: not-allowed; }
.hint { margin: 0; font-size: 0.78rem; color: #8b93a1; line-height: 1.45; }
.hint.bad { color: #d8453f; }

/* In the header the buttons are the whole component. */
.board.compact { flex-direction: row; align-items: center; gap: 0; }
.board.compact .actions { gap: 0.3rem; flex-wrap: nowrap; }
.board.compact .actions button { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.board.compact .hint.bad { font-size: 0.72rem; }

</style>
