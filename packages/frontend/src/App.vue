<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { parseSegmentLabel, type Segment } from '@darts/schema';
import BoardControls from './components/BoardControls.vue';
import BoardEffect from './components/BoardEffect.vue';
import Celebration from './components/Celebration.vue';
import Dartboard from './components/Dartboard.vue';
import FitToScreen from './components/FitToScreen.vue';
import TurnNotice from './components/TurnNotice.vue';
import { useScreenAwake } from './screenAwake.ts';
import Leaderboard from './components/Leaderboard.vue';
import MatchOverview from './components/MatchOverview.vue';
import MatchSetup from './components/MatchSetup.vue';
import ProfilePanel from './components/ProfilePanel.vue';
import PlayerStrip from './components/PlayerStrip.vue';
import Scoreboard from './components/Scoreboard.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import { api, connect, dismissCelebration, dismissStuckTakeout, pushToast, store, type MatchReport } from './store.ts';

const tab = ref<'play' | 'setup' | 'leaderboard' | 'players' | 'settings'>('play');
const view = computed(() => store.view);
const { state: screenAwake, retry: retryScreenAwake } = useScreenAwake(computed(() => view.value?.status === 'playing'));
const screenAwakeDescription = computed(() => {
  if (screenAwake.value === 'active') return 'Screen stays awake while this match is playing.';
  if (screenAwake.value === 'unsupported') return 'Keeping the screen awake requires a supported browser and HTTPS (or localhost). On a plain HTTP network address, use your device’s screen-timeout settings.';
  if (screenAwake.value === 'requesting') return 'Requesting permission to keep the screen awake…';
  if (screenAwake.value === 'inactive') return 'The screen stays awake during a visible, active match.';
  return 'Screen wake lock was declined or released. Tap to retry; power-saving settings may prevent it.';
});
const recentThrows = computed(() => {
  const recent = [...(view.value?.recent ?? [])].reverse();
  return Array.from({ length: 6 }, (_, i) => recent[i] ?? null);
});
const managingRoster = ref(false);
const rosterToggle = ref<HTMLButtonElement | null>(null);
const rosterClose = ref<HTMLButtonElement | null>(null);
watch(managingRoster, async (open) => {
  await nextTick();
  (open ? rosterClose.value : rosterToggle.value)?.focus();
});
const matchScreen = computed(() => tab.value === 'play' && view.value !== null);
const headerExpanded = ref(false);

watch([matchScreen, () => view.value?.matchId], () => {
  headerExpanded.value = false;
});

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

/** The board stuck on "Takeout in progress": hand over, then zero its counter. */
async function forceTakeout(): Promise<void> {
  dismissStuckTakeout();
  await api.command({ type: 'NEXT_PLAYER' });
  void api.boardAction('reset');
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

watch(() => store.completedReport, (completed) => {
  if (!completed || shown.value.has(completed.matchId)) return;
  shown.value.add(completed.matchId);
  // Store snapshots are exposed as readonly; the overview only reads them.
  report.value = completed as MatchReport;
});

async function openReport(matchId: string): Promise<void> {
  try {
    report.value = await api.matchReport(matchId);
    shown.value.add(report.value.matchId);
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
    // A live finish delivers its report over WS. Keep HTTP for reconnects,
    // where only a finished view is sent, and cancel it if the report arrives.
    setTimeout(() => {
      if (shown.value.has(matchId) || view.value?.matchId !== matchId || view.value.status !== 'finished') return;
      void openReport(matchId);
    }, 150);
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
  <div class="app" :class="{ 'match-screen': matchScreen }">
    <header class="top" :class="{ 'match-header': matchScreen }" @keydown.esc="headerExpanded = false">
      <div v-if="matchScreen" class="compact-toolbar">
        <span class="compact-board-status" role="status">
          <span class="status-light" :class="{ online: store.connected && store.boardOnline }" />
          {{ !store.connected ? 'Server offline' : store.boardOnline ? (store.boardStatus ?? 'Board connected') : 'Board offline' }}
        </span>
        <div class="quick-controls">
          <BoardControls compact class="toolbar-board-controls" />
          <button class="awake-indicator" :class="{ awake: screenAwake === 'active' }" :title="screenAwakeDescription" :aria-label="screenAwakeDescription" @click="screenAwake === 'unsupported' ? (headerExpanded = true) : retryScreenAwake()">{{ screenAwake === 'active' ? '☀ Awake' : '◐ Screen' }}</button>
        </div>
        <button class="menu-toggle" :aria-expanded="headerExpanded" aria-controls="header-content" @click="headerExpanded = !headerExpanded">
          {{ headerExpanded ? 'Close menu ×' : 'Menu ☰' }}
        </button>
      </div>
      <div v-show="!matchScreen || headerExpanded" id="header-content" class="header-content">
        <div class="brand">
          <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16"/><circle cx="20" cy="20" r="10"/><circle cx="20" cy="20" r="3"/><path d="M20 20 33 7m-7 0h7v7"/></svg>
          <div><h1>Darts</h1><span>Your game. Your next level.</span></div>
        </div>
        <nav aria-label="Main navigation">
          <button :aria-current="tab === 'play' ? 'page' : undefined" :class="{ on: tab === 'play' }" @click="tab = 'play'">Play</button>
          <button :aria-current="tab === 'setup' ? 'page' : undefined" :class="{ on: tab === 'setup' }" @click="tab = 'setup'">New match</button>
          <button :aria-current="tab === 'leaderboard' ? 'page' : undefined" :class="{ on: tab === 'leaderboard' }" @click="tab = 'leaderboard'">Leaderboard</button>
          <button :aria-current="tab === 'players' ? 'page' : undefined" :class="{ on: tab === 'players' }" @click="tab = 'players'">Players</button>
          <button :aria-current="tab === 'settings' ? 'page' : undefined" :class="{ on: tab === 'settings' }" @click="tab = 'settings'">Settings</button>
        </nav>
        <div class="status">
          <!--
            During a match these controls live beside the Awake indicator.
            The full panel, with its indicator and explanation, is in Settings.
          -->
          <BoardControls v-if="!matchScreen" compact />
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
        <div class="wake-status" role="status"><strong>{{ screenAwake === 'active' ? 'Screen awake' : screenAwake === 'unsupported' ? 'Screen wake lock unavailable' : 'Keep screen awake' }}</strong><span>{{ screenAwakeDescription }}</span><button v-if="screenAwake === 'released' || screenAwake === 'blocked'" class="menu-toggle" @click="retryScreenAwake">Retry</button></div>
      </div>
    </header>

    <main>
      <template v-if="tab === 'play'">
        <FitToScreen v-if="view">
          <div class="play-view">
            <!--
              The roster spans the whole window rather than sitting in the left
              column: it is the one element every game needs room for, and the
              two-column grid below would otherwise cost it half its width.
            -->
            <div class="match-heading">
              <p class="page-eyebrow">{{ view.status === 'finished' ? 'Final scores' : 'Live at the oche' }}</p>
              <span>{{ view.players.length }} {{ view.players.length === 1 ? 'player' : 'players' }} · {{ view.gameType === 'evenodd' ? 'Even / Odd' : view.gameType.toUpperCase() }}</span>
            </div>
            <PlayerStrip v-if="view.gameType !== 'cricket'" :view="view" fit />

            <div class="play">
              <section class="left">
                <Scoreboard :view="view" />
              </section>

              <section class="right">
                <div class="board-heading"><span>On the board</span><span class="board-heading-note">{{ correcting ? 'Correcting last dart' : 'Aim. Throw. Repeat.' }}</span></div>
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
                <TurnNotice :stuck="store.takeoutStuck" :awaiting-takeout="!!view.awaitingTakeout" :correcting="correcting" @force-takeout="forceTakeout" />

                <div class="controls">
                  <button @click="undo">Undo dart</button>
                  <button @click="nextPlayer">End turn</button>
                  <button :class="{ on: correcting }" :aria-pressed="correcting" @click="correcting = !correcting">
                    Correct last dart
                  </button>
                  <button ref="rosterToggle" :class="{ on: managingRoster }" @click="managingRoster = !managingRoster">
                    Players
                  </button>
                  <button class="danger" :disabled="view.status !== 'playing'" @click="endGame">
                    End game
                  </button>
                  <button @click="showLastGame">Last game</button>
                </div>

                <Teleport to="body">
                  <div v-if="managingRoster" class="roster-overlay" role="dialog" aria-modal="true" aria-label="Match players" @click.self="managingRoster = false" @keydown.esc="managingRoster = false">
                    <section class="roster">
                      <div class="roster-heading"><h2>Match players</h2><button ref="rosterClose" class="menu-toggle" @click="managingRoster = false">Close ×</button></div>
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
                    </section>
                  </div>
                </Teleport>

                <ul class="recent" aria-label="Recent darts">
                  <li v-for="(t, i) in recentThrows" :key="i" :class="{ placeholder: !t }" :aria-hidden="!t">
                    <span class="label">{{ t?.label ?? '—' }}</span>
                    <span class="value">{{ t?.value ?? '—' }}</span>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </FitToScreen>

        <div v-else class="empty">
          <div class="empty-target" aria-hidden="true">◎</div>
          <p class="page-eyebrow">Make every dart count</p>
          <h2>Ready for your next match?</h2>
          <p>Choose a game, gather your players and step up to the oche.</p>
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
      :compact="!!report"
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
.app { width: 100%; margin: 0; padding: 1rem 1.25rem; }
.top { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
h1 { margin: 0; font-size: 1.3rem; letter-spacing: 0.02em; }
nav { display: flex; gap: 0.4rem; }
nav button {
  background: var(--ui-surface); border: 1px solid var(--ui-border); color: var(--ui-secondary);
  border-radius: 999px; padding: 0.4rem 0.95rem; cursor: pointer; font: inherit;
}
nav button.on { background: #2b3240; border-color: var(--ui-accent); color: #fff; }
.status { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; }
.pill {
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
  border: 1px solid #3a2226; background: #24161a; color: var(--ui-danger);
  border-radius: 999px; padding: 0.2rem 0.6rem;
}
.pill.ok { border-color: #1f3a2a; background: #16241c; color: var(--ui-success); }

.play-view { display: flex; flex-direction: column; gap: 0.85rem; }
.play { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, min(33%, 420px)); gap: 1.5rem; align-items: start; }
@media (max-width: 900px) {
  .play { grid-template-columns: 1fr; }
  .board-stage { max-width: 420px; margin: 0 auto; }
}
.left, .right { display: flex; flex-direction: column; gap: 0.85rem; }

.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.controls button {
  background: var(--ui-surface); border: 1px solid var(--ui-border); color: var(--ui-secondary);
  border-radius: 6px; padding: 0.5rem 0.85rem; cursor: pointer; font: inherit;
}
.controls button.on { border-color: #e0a458; color: #e0a458; }
.controls button.danger { border-color: #45262a; color: #c9645f; }
.controls button.danger:hover:not(:disabled) { border-color: var(--ui-danger); color: var(--ui-danger); }
.controls button:disabled { opacity: 0.4; cursor: not-allowed; }

/* Positions the burst overlay over the board, and takes the shake. */
.board-stage { position: relative; width: 100%; }
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

.hint { margin: 0; font-size: 0.8rem; color: var(--ui-muted); }

.recent { list-style: none; margin: 0; padding: 0; display: flex; gap: 0.4rem; flex-wrap: wrap; }
.recent li {
  display: flex; gap: 0.35rem; align-items: baseline;
  background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: 6px; padding: 0.25rem 0.5rem;
  font-size: 0.8rem;
}
.recent .value { color: var(--ui-muted); }

.roster { border: 1px solid var(--ui-border); border-radius: 8px; padding: 0.75rem 0.9rem; background: var(--ui-surface); }
.roster ul { list-style: none; margin: 0.5rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.roster li { display: flex; align-items: center; gap: 0.55rem; }
.roster .dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; flex: none; }
.roster .who { flex: 1; }
.roster .del { background: none; border: none; color: #6b7280; font-size: 1.2rem; cursor: pointer; padding: 0 0.3rem; }
.roster .del:hover:not(:disabled) { color: var(--ui-danger); }
.roster .del:disabled { opacity: 0.3; cursor: not-allowed; }
.join { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.chip {
  background: var(--ui-surface); border: 1px solid var(--accent); color: var(--ui-secondary);
  border-radius: 999px; padding: 0.3rem 0.8rem; cursor: pointer; font: inherit; font-size: 0.85rem;
}
.chip:hover { background: color-mix(in srgb, var(--accent) 22%, var(--ui-surface)); }

.empty { text-align: center; padding: 4rem 1rem; color: var(--ui-muted); }
.empty-actions { display: flex; gap: 0.5rem; justify-content: center; }
.primary { background: var(--ui-accent); border: none; color: #fff; border-radius: 8px; padding: 0.6rem 1.2rem; cursor: pointer; font-weight: 600; }
.ghost { background: none; border: 1px solid var(--ui-border); color: var(--ui-secondary); border-radius: 8px; padding: 0.6rem 1.2rem; cursor: pointer; font: inherit; }

.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem; z-index: 20; }
.toast {
  display: flex; gap: 0.6rem; align-items: center;
  background: var(--ui-surface-raised); border: 1px solid #333a45; border-radius: 8px;
  padding: 0.6rem 0.9rem; box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.toast .icon { font-size: 1.3rem; }
.toast b { display: block; font-size: 0.85rem; }
.toast small { color: var(--ui-muted); font-size: 0.75rem; }

.app { padding: 1.25rem clamp(0.75rem, 2.5vw, 2.5rem) 2.5rem; max-width: 1920px; margin-inline: auto; }
.top { padding: 0.9rem 1.1rem; border: 1px solid var(--ui-border); border-radius: 18px; background: linear-gradient(120deg, #14374b, #0c2132); box-shadow: var(--ui-shadow); gap: 1.25rem; }
.brand { display: flex; align-items: center; gap: 0.7rem; }
.brand svg { width: 2.7rem; height: 2.7rem; fill: none; stroke: var(--ui-accent); stroke-width: 1.7; }
.brand h1 { font-size: 1.5rem; letter-spacing: -0.04em; }
.brand span { color: var(--ui-muted); font-size: 0.68rem; }
nav { background: #07162170; padding: 0.3rem; border-radius: 12px; gap: 0.15rem; flex-wrap: wrap; }
nav button { border-color: transparent; background: transparent; border-radius: 9px; padding: 0.55rem 0.85rem; font-size: 0.85rem; font-weight: 600; }
nav button:hover { color: var(--ui-text); background: #ffffff08; }
nav button.on { background: #56cfff1a; color: var(--ui-accent); border-color: #56cfff40; box-shadow: inset 0 -2px var(--ui-accent); }
.status { flex-wrap: wrap; gap: 0.4rem; }
.pill { font-size: 0.62rem; padding: 0.25rem 0.55rem; }
.pill.ok { color: var(--ui-success); background: #18382e; border-color: #31614e; }
.match-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.25rem 0.1rem 0; }
.match-heading p { margin: 0; }.match-heading > span { font-size: 0.75rem; color: var(--ui-muted); }
.play { gap: 1rem; }.play-view { gap: 1rem; }
.right { border: 1px solid var(--ui-border); border-radius: 18px; padding: 1rem; background: linear-gradient(155deg, #102c3d, #0b1b29); box-shadow: var(--ui-shadow); }
.board-heading { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.3rem; font-size: 0.75rem; font-weight: 650; }.board-heading-note { font-size: 0.68rem; color: var(--ui-muted); font-weight: 400; }
.controls { gap: 0.4rem; }.controls button { padding: 0.6rem 0.7rem; border-radius: 9px; font-size: 0.78rem; }
.controls button:hover:not(:disabled) { background: var(--ui-surface-raised); border-color: #4b7188; }
.recent li { border-radius: 8px; background: var(--ui-surface-deep); }.recent .label { font-weight: 700; color: var(--ui-accent); }
.empty { max-width: 900px; margin: 4vh auto; padding: clamp(2rem, 6vw, 5rem) 1rem; border: 1px solid var(--ui-border); border-radius: 24px; background: radial-gradient(ellipse at top, #16465c80, transparent 70%), var(--ui-surface-deep); box-shadow: var(--ui-shadow); }
.empty-target { font-size: 5rem; line-height: 1.2; color: var(--ui-accent); margin-bottom: 1rem; }
.empty h2 { color: var(--ui-text); font-size: clamp(1.65rem, 4vw, 2.8rem); letter-spacing: -0.04em; margin: 0.5rem 0; }
.empty > p:not(.page-eyebrow) { line-height: 1.6; }.empty-actions { margin-top: 1.5rem; }
.primary { background: linear-gradient(120deg, #71dcff, #40b9ef); color: #062337; border-radius: 10px; }
.ghost { border-radius: 10px; }.toast { border-color: var(--ui-border); border-radius: 12px; background: var(--ui-surface-raised); max-width: min(420px, calc(100vw - 2rem)); }
@media (max-width: 1250px) { .status { margin-left: 0; width: 100%; padding-top: 0.65rem; border-top: 1px solid var(--ui-border-soft); } }
@media (max-width: 640px) { .top { gap: 0.8rem; padding: 0.85rem; }.brand { width: 100%; } nav { width: 100%; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); } nav button { grid-column: span 2; padding: 0.5rem 0.2rem; font-size: 0.75rem; } nav button:nth-last-child(-n+2) { grid-column: span 3; }.right { padding: 0.8rem; }.status { row-gap: 0.65rem; } }


/* The live match owns the viewport. Menus and dialogs have their own layers,
   so opening a tool never changes the scale of the scoreboard. */
.header-content { display: contents; }
.app.match-screen {
  height: 100dvh; max-width: none; display: flex; flex-direction: column;
  padding: max(0.5rem, env(safe-area-inset-top)) max(0.5rem, env(safe-area-inset-right)) max(0.5rem, env(safe-area-inset-bottom)) max(0.5rem, env(safe-area-inset-left));
  overflow: hidden;
}
.match-screen > main { flex: 1; min-height: 0; }
.top.match-header { position: relative; z-index: 25; flex: none; padding: 0.3rem 0.65rem; margin-bottom: 0.5rem; border-radius: 10px; }
.compact-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; width: 100%; min-height: 1.9rem; }
.compact-board-status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: var(--ui-secondary); }
.status-light { width: 0.45rem; height: 0.45rem; flex: none; background: var(--ui-danger); border-radius: 50%; }
.status-light.online { background: var(--ui-success); box-shadow: 0 0 8px #69d9ad50; }
.menu-toggle { background: var(--ui-surface-deep); border: 1px solid var(--ui-border); border-radius: 7px; color: var(--ui-secondary); padding: 0.35rem 0.7rem; font: inherit; font-size: 0.75rem; }
.menu-toggle:hover { border-color: var(--ui-accent); }
.match-header .header-content { position: absolute; top: calc(100% + 0.4rem); left: 0; right: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; max-height: calc(100dvh - 4rem); overflow-y: auto; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 14px; background: #0e2738; box-shadow: 0 18px 48px #0008; }
.match-screen .play-view { gap: 0.65rem; padding: 0.15rem; }
.match-screen .match-heading { padding: 0; }
.match-screen .play { grid-template-columns: minmax(0, 1fr) minmax(0, min(34%, 420px)); gap: 0.75rem; }
.roster-overlay { position: fixed; inset: 0; z-index: 35; display: grid; place-items: center; padding: 1rem; background: #050e19b8; }
.roster-overlay .roster { width: min(600px, 100%); max-height: 85dvh; overflow: auto; padding: 1.25rem; border-radius: 16px; box-shadow: var(--ui-shadow); }
.roster-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.roster-heading h2 { margin: 0; font-size: 1.2rem; }
@media (max-width: 640px) and (orientation: portrait) {
  .match-screen .play { grid-template-columns: 1fr; gap: 0.6rem; }
}
@media (max-width: 640px) and (orientation: portrait), (max-height: 600px) and (orientation: landscape) {
  .match-screen .right { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 0.45rem 0.6rem; padding: 0.65rem; align-items: center; }
  .match-screen .board-stage { grid-column: 1; grid-row: 1 / 6; align-self: start; }
  .match-screen .board-heading, .match-screen :deep(.turn-notice), .match-screen .controls { grid-column: 2; }
  .match-screen .board-heading-note { display: none; }
  .match-screen :deep(.turn-notice) { font-size: 0.62rem; text-align: left; line-height: 1.4; }
  .match-screen .controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.3rem; }
  .match-screen .controls button { padding: 0.45rem 0.25rem; font-size: 0.65rem; }
  .match-screen .recent { grid-column: 1 / -1; }
  .match-screen :deep(.scoreboard) { padding: 0.65rem; gap: 0.55rem; }
  .match-screen :deep(.scoreboard .meta) { padding-bottom: 0.4rem; gap: 0.6rem; }
  .match-screen :deep(.scoreboard .player) { padding: 0.65rem 0.8rem; }
  .match-screen :deep(.scoreboard .score) { font-size: 4rem; padding: 0; }
  .match-screen :deep(.scoreboard .stats) { padding-top: 0.4rem; margin-top: 0.3rem; }
  .match-screen :deep(.scoreboard .slot) { min-height: 3.7rem; font-size: 2.3rem; }
  .match-screen :deep(.scoreboard .turn-total) { padding: 0.3rem 0.65rem; }
  .match-screen :deep(.scoreboard .turn-total .value) { font-size: 1.6rem; }
  .match-screen .match-heading > span { font-size: 0.65rem; }
}

@media (max-height: 600px) and (orientation: landscape) {
  .match-screen .play { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
  .match-screen .play-view { gap: 0.4rem; }
  .match-screen :deep(.scoreboard .score) { font-size: 3rem; }
  .match-screen :deep(.scoreboard .name) { font-size: 0.95rem; }
  .match-screen :deep(.scoreboard .slot) { min-height: 3rem; font-size: 2rem; }
  .match-screen :deep(.scoreboard .game) { padding: 0.2rem 0.4rem; }
}

.compact-board-status { margin-right: auto; min-width: 0; white-space: nowrap; overflow: hidden; }
.compact-toolbar > button { flex: none; }
.quick-controls { display: flex; align-items: center; gap: 0.65rem; flex: none; }
.match-header .compact-toolbar :deep(.board.compact .actions) { flex-wrap: nowrap; }
@media (max-width: 640px) {
  .compact-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.35rem 0.75rem; }
  .compact-toolbar > .menu-toggle { grid-column: 2; grid-row: 1; }
  .quick-controls { grid-column: 1 / -1; justify-content: space-between; gap: 0.4rem; }
  .match-header .compact-toolbar :deep(.board.compact .actions button) { padding: 0.3rem 0.45rem; font-size: 0.72rem; }
}
.awake-indicator { background: none; border: 0; color: var(--ui-muted); font-size: 0.7rem; white-space: nowrap; padding: 0.3rem; }
.awake-indicator.awake { color: var(--ui-success); }
.wake-status { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.75rem; font-size: 0.75rem; color: var(--ui-muted); border-top: 1px solid var(--ui-border-soft); padding-top: 0.6rem; }
.wake-status strong { color: var(--ui-secondary); }.wake-status span { flex: 1 1 16rem; line-height: 1.5; }
.board-heading { flex-wrap: nowrap; }.board-heading-note { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.recent li { min-width: 0; justify-content: space-between; white-space: nowrap; line-height: 1.25rem; }
.recent li.placeholder { visibility: hidden; }
</style>
