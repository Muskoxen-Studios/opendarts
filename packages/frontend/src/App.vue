<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { parseSegmentLabel, type Segment } from '@darts/schema';
import BoardControls from './components/BoardControls.vue';
import BoardEffect from './components/BoardEffect.vue';
import Celebration from './components/Celebration.vue';
import Dartboard from './components/Dartboard.vue';
import Leaderboard from './components/Leaderboard.vue';
import MatchOverview from './components/MatchOverview.vue';
import MatchSetup from './components/MatchSetup.vue';
import ProfilePanel from './components/ProfilePanel.vue';
import Scoreboard from './components/Scoreboard.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import { api, connect, dismissCelebration, pushToast, store, type MatchReport } from './store.ts';

const tab = ref<'play' | 'setup' | 'leaderboard' | 'players' | 'settings'>('play');
const view = computed(() => store.view);
const managingRoster = ref(false);

/** Profiles not currently in the match, offered as mid-match additions. */
const availableToJoin = computed(() =>
  store.profiles.filter((p) => !view.value?.players.some((x) => x.playerId === p.id)),
);

onMounted(async () => {
  connect();
  await Promise.all([api.loadProfiles(), api.settings().catch(() => null)]);
  if (!store.view) tab.value = store.profiles.length === 0 ? 'players' : 'setup';
});

async function addToMatch(profileId: string): Promise<void> {
  try {
    await api.addPlayerToMatch(profileId);
  } catch (err) {
    pushToast('Could not add player', (err as Error).message, '\u{26A0}');
  }
}

/**
 * Take a player out of the running match.
 *
 * Confirmed by name: mid-match this drops their score, and the
 * button sits next to the one that adds a player.
 */
async function removeFromMatch(profileId: string): Promise<void> {
  const name = store.profiles.find((p) => p.id === profileId)?.name ?? 'this player';
  if (!confirm(`Remove ${name} from the match? Their score in this match goes with them.`)) return;
  try {
    await api.removePlayerFromMatch(profileId);
  } catch (err) {
    pushToast('Could not remove player', (err as Error).message, '\u{26A0}');
  }
}

async function onThrow(payload: { segment: Segment; coords: { x: number; y: number } }): Promise<void> {
  try {
    await api.simulate(payload.segment, payload.coords);
  } catch (err) {
    pushToast('Could not register dart', (err as Error).message, '\u{26A0}');
  }
}

function undo(): void {
  void api.command({ type: 'UNDO' });
}

function nextPlayer(): void {
  void api.command({ type: 'NEXT_PLAYER' });
}

/**
 * Stop the match here and award it to whoever is closest to winning.
 *
 * Confirmed first: it is the one control on this screen that cannot be undone
 * by throwing another dart.
 */
async function endGame(): Promise<void> {
  if (!confirm('End the game now? It will be saved and awarded to whoever is closest to winning.')) {
    return;
  }
  try {
    await api.command({ type: 'END_MATCH' });
  } catch (err) {
    pushToast('Could not end the game', (err as Error).message, '\u{26A0}');
  }
}

/** Correct the most recent dart, including one that already caused a handover. */
async function correctLast(segment: Segment): Promise<void> {
  const last = view.value?.recent.at(-1);
  if (!last) return;
  await api.command({ type: 'CORRECT_THROW', throwId: last.id, segment });
  correcting.value = false;
}

const correcting = ref(false);

// -- the board's target highlighting ----------------------------------------

/**
 * The checkout route, as segments to light up on the board.
 *
 * Empty while correcting a dart: the board is then an input for "what did it
 * actually hit", and suggesting an answer there would be misleading.
 */
/** Games whose hints name a whole number rather than a specific ring. */
const WHOLE_NUMBER_HINT_GAMES = new Set(['golf', 'shanghai']);

const hintSegments = computed<Segment[]>(() => {
  if (!view.value || correcting.value || WHOLE_NUMBER_HINT_GAMES.has(view.value.gameType)) return [];
  return view.value.turn.hints
    .map((h) => parseSegmentLabel(h))
    .filter((s): s is Segment => s !== null);
});

/** Golf and Shanghai aim at a whole number rather than a particular ring. */
const hintNumbers = computed<number[]>(() => {
  if (!view.value || correcting.value || !WHOLE_NUMBER_HINT_GAMES.has(view.value.gameType)) return [];
  const hole = Number(view.value.turn.hints[0]);
  return Number.isInteger(hole) ? [hole] : [];
});

/**
 * Which of the two identical shake animations to run.
 *
 * Alternating on the effect's key is what makes a second bust actually shake:
 * re-applying the same animation name to an element that already has it is a
 * no-op, so consecutive bursts would silently drop every other shake.
 */
const shakeClass = computed(() => {
  const effect = store.boardEffect;
  if (!effect || store.effects === 'off') return null;
  return effect.key % 2 === 0 ? 'shake-a' : 'shake-b';
});

/** The player whose darts are on the board -- still them while a finished turn is held for takeout. */
const activePlayer = computed(() => view.value?.players.find((p) => p.playerId === view.value?.activePlayerId));

// -- match overview ----------------------------------------------------------

const report = ref<MatchReport | null>(null);
/** Matches whose overview has already been offered, so it is not forced twice. */
const shown = ref(new Set<string>());

async function openReport(matchId: string): Promise<void> {
  try {
    report.value = await api.matchReport(matchId);
  } catch (err) {
    pushToast('No match to show', (err as Error).message, '\u{26A0}');
  }
}

/** The overview of the last finished match, from the play screen. */
function showLastGame(): void {
  void openReport('last');
}

/**
 * Show the overview automatically the moment a match finishes -- including when
 * it was ended early, which is exactly when a summary is most wanted.
 */
watch(
  () => [view.value?.matchId, view.value?.status] as const,
  ([matchId, status]) => {
    if (!matchId || status !== 'finished' || shown.value.has(matchId)) return;
    shown.value.add(matchId);
    void openReport(matchId);
  },
);

/** Start a fresh match with the same game, settings and players. */
async function rematch(): Promise<void> {
  const matchId = report.value?.matchId;
  if (!matchId) return;
  try {
    const setup = await api.matchSetup(matchId);
    await api.startMatch(setup.config, setup.playerIds);
    report.value = null;
    tab.value = 'play';
  } catch (err) {
    pushToast('Could not start a rematch', (err as Error).message, '\u{26A0}');
  }
}
</script>

<template>
  <div class="app">
    <header class="top">
      <h1>Darts</h1>
      <nav>
        <button :class="{ on: tab === 'play' }" @click="tab = 'play'">Play</button>
        <button :class="{ on: tab === 'setup' }" @click="tab = 'setup'">New match</button>
        <button :class="{ on: tab === 'leaderboard' }" @click="tab = 'leaderboard'">Leaderboard</button>
        <button :class="{ on: tab === 'players' }" @click="tab = 'players'">Players</button>
        <button :class="{ on: tab === 'settings' }" @click="tab = 'settings'">Settings</button>
      </nav>
      <div class="status">
        <!--
          Reset and Calibrate are hardware controls wanted mid-game, with darts
          in hand and the board misreading -- so they sit in the header rather
          than behind a disclosure on the play screen. The full panel, with its
          indicator and explanation, is on the Settings screen.
        -->
        <BoardControls compact />
        <span class="pill" :class="{ ok: store.connected }">
          {{ store.connected ? 'server' : 'offline' }}
        </span>
        <span
          class="pill"
          :class="{ ok: store.boardOnline }"
          :title="store.boardStatus ? `Board status: ${store.boardStatus}` : 'No status from the board'"
        >
          {{ store.boardOnline ? (store.boardStatus ?? 'board') : 'no board' }}
        </span>
      </div>
    </header>

    <main>
      <template v-if="tab === 'play'">
        <div v-if="view" class="play">
          <section class="left">
            <Scoreboard :view="view" />
          </section>

          <section class="right">
            <div class="board-stage" :class="shakeClass">
              <Dartboard
                :highlight="hintSegments"
                :highlight-numbers="hintNumbers"
                :marks="view.turn.throws"
                :mark-color="activePlayer?.color"
                @throw="correcting ? correctLast($event.segment) : onThrow($event)"
              />
              <BoardEffect :effect="store.boardEffect" :level="store.effects" />
            </div>
            <p v-if="view.awaitingTakeout" class="hint centered takeout">
              {{ activePlayer?.name }}'s turn is done -- pull your darts to hand over.
            </p>
            <p v-else class="hint centered">
              Click the board to throw. Simulated darts travel through the bridge,
              the same path real ones will.
            </p>

            <div class="controls">
              <button @click="undo">Undo dart</button>
              <button @click="nextPlayer">End turn</button>
              <button :class="{ on: correcting }" @click="correcting = !correcting">
                {{ correcting ? 'Pick the real segment…' : 'Correct last dart' }}
              </button>
              <button :class="{ on: managingRoster }" @click="managingRoster = !managingRoster">
                Players
              </button>
              <button class="danger" :disabled="view.status !== 'playing'" @click="endGame">
                End game
              </button>
              <button @click="showLastGame">Last game</button>
            </div>

            <div v-if="managingRoster" class="roster">
              <p class="hint">
                Joining players start a fresh score; the leg carries on. Removing
                the player who is throwing ends their turn.
              </p>
              <ul>
                <li v-for="p in view.players" :key="p.playerId">
                  <span class="dot" :style="{ background: p.color }" />
                  <span class="who">{{ p.name }}</span>
                  <button
                    class="del"
                    :disabled="view.players.length <= 1"
                    :title="view.players.length <= 1 ? 'A match needs at least one player' : 'Remove from match'"
                    @click="removeFromMatch(p.playerId)"
                  >&times;</button>
                </li>
              </ul>
              <div v-if="availableToJoin.length" class="join">
                <button
                  v-for="p in availableToJoin"
                  :key="p.id"
                  class="chip"
                  :style="{ '--accent': p.color }"
                  @click="addToMatch(p.id)"
                >+ {{ p.name }}</button>
              </div>
              <p v-else class="hint">Everyone is already in this match.</p>
            </div>

            <p v-if="correcting" class="hint">
              Click the segment the dart actually hit. This works even after a
              misread dart has already busted the turn and handed over.
            </p>

            <ul v-if="view.recent.length" class="recent">
              <li v-for="t in [...view.recent].reverse().slice(0, 6)" :key="t.id">
                <span class="label">{{ t.label }}</span>
                <span class="value">{{ t.value }}</span>
              </li>
            </ul>
          </section>
        </div>

        <div v-else class="empty">
          <p>No match in progress.</p>
          <div class="empty-actions">
            <button class="primary" @click="tab = 'setup'">Set one up</button>
            <button class="ghost" @click="showLastGame">Last game</button>
          </div>
        </div>
      </template>

      <MatchSetup v-else-if="tab === 'setup'" @started="tab = 'play'" />
      <Leaderboard v-else-if="tab === 'leaderboard'" />
      <SettingsPanel v-else-if="tab === 'settings'" />
      <ProfilePanel v-else />
    </main>

    <MatchOverview
      v-if="report"
      :report="report"
      :can-replay="true"
      @close="report = null"
      @rematch="rematch"
    />

    <Celebration
      :celebration="store.celebration"
      :queued="store.celebrationQueue.length"
      @dismiss="dismissCelebration"
    />

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast">
        <span class="icon">{{ t.icon }}</span>
        <span><b>{{ t.title }}</b><small>{{ t.body }}</small></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { max-width: 1180px; margin: 0 auto; padding: 1rem; }
.top { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
h1 { margin: 0; font-size: 1.3rem; letter-spacing: 0.02em; }
nav { display: flex; gap: 0.4rem; }
nav button {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 999px; padding: 0.4rem 0.95rem; cursor: pointer; font: inherit;
}
nav button.on { background: #2b3240; border-color: #4f8ef7; color: #fff; }
.status { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; }
.pill {
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
  border: 1px solid #3a2226; background: #24161a; color: #d8453f;
  border-radius: 999px; padding: 0.2rem 0.6rem;
}
.pill.ok { border-color: #1f3a2a; background: #16241c; color: #3f9d54; }

.play { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 560px); gap: 1.5rem; align-items: start; }
@media (max-width: 900px) { .play { grid-template-columns: 1fr; } }
.left, .right { display: flex; flex-direction: column; gap: 0.85rem; }

.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.controls button {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 6px; padding: 0.5rem 0.85rem; cursor: pointer; font: inherit;
}
.controls button.on { border-color: #e0a458; color: #e0a458; }
.controls button.danger { border-color: #45262a; color: #c9645f; }
.controls button.danger:hover:not(:disabled) { border-color: #d8453f; color: #d8453f; }
.controls button:disabled { opacity: 0.4; cursor: not-allowed; }

/* Positions the burst overlay over the board, and takes the shake. */
.board-stage { position: relative; width: 100%; max-width: 560px; }
.board-stage.shake-a { animation: shake-a 420ms ease-in-out; }
.board-stage.shake-b { animation: shake-b 420ms ease-in-out; }

@keyframes shake-a {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  15%  { transform: translate(-9px, 4px) rotate(-0.7deg); }
  35%  { transform: translate(7px, -5px) rotate(0.6deg); }
  55%  { transform: translate(-5px, 3px) rotate(-0.4deg); }
  78%  { transform: translate(3px, -2px) rotate(0.2deg); }
}
/* Deliberately identical to shake-a; see shakeClass in the script above. */
@keyframes shake-b {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  15%  { transform: translate(-9px, 4px) rotate(-0.7deg); }
  35%  { transform: translate(7px, -5px) rotate(0.6deg); }
  55%  { transform: translate(-5px, 3px) rotate(-0.4deg); }
  78%  { transform: translate(3px, -2px) rotate(0.2deg); }
}

@media (prefers-reduced-motion: reduce) {
  .board-stage.shake-a, .board-stage.shake-b { animation: none; }
}

.hint { margin: 0; font-size: 0.8rem; color: #8b93a1; }
.hint.centered { text-align: center; }
.hint.takeout { color: #e0a458; font-weight: 600; }

.recent { list-style: none; margin: 0; padding: 0; display: flex; gap: 0.4rem; flex-wrap: wrap; }
.recent li {
  display: flex; gap: 0.35rem; align-items: baseline;
  background: #14171c; border: 1px solid #262b33; border-radius: 6px; padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
}
.recent .value { color: #8b93a1; }

.roster { border: 1px solid #262b33; border-radius: 8px; padding: 0.75rem 0.9rem; background: #14171c; }
.roster ul { list-style: none; margin: 0.5rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.roster li { display: flex; align-items: center; gap: 0.55rem; }
.roster .dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; flex: none; }
.roster .who { flex: 1; }
.roster .del { background: none; border: none; color: #6b7280; font-size: 1.2rem; cursor: pointer; padding: 0 0.3rem; }
.roster .del:hover:not(:disabled) { color: #d8453f; }
.roster .del:disabled { opacity: 0.3; cursor: not-allowed; }
.join { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.chip {
  background: #14171c; border: 1px solid var(--accent); color: #cdd3dc;
  border-radius: 999px; padding: 0.3rem 0.8rem; cursor: pointer; font: inherit; font-size: 0.85rem;
}
.chip:hover { background: color-mix(in srgb, var(--accent) 22%, #14171c); }

.empty { text-align: center; padding: 4rem 1rem; color: #8b93a1; }
.empty-actions { display: flex; gap: 0.5rem; justify-content: center; }
.primary { background: #4f8ef7; border: none; color: #fff; border-radius: 8px; padding: 0.6rem 1.2rem; cursor: pointer; font-weight: 600; }
.ghost { background: none; border: 1px solid #333b49; color: #cdd3dc; border-radius: 8px; padding: 0.6rem 1.2rem; cursor: pointer; font: inherit; }

.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem; z-index: 20; }
.toast {
  display: flex; gap: 0.6rem; align-items: center;
  background: #1b2029; border: 1px solid #333a45; border-radius: 8px;
  padding: 0.6rem 0.9rem; box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.toast .icon { font-size: 1.3rem; }
.toast b { display: block; font-size: 0.85rem; }
.toast small { color: #8b93a1; font-size: 0.75rem; }
</style>
