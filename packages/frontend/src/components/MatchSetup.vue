<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, store, type GolfHandicap, type ModeHandicap } from '../store.ts';
import GameManual from './GameManual.vue';

const emit = defineEmits<{ (e: 'started'): void }>();

type GameType = 'x01' | 'cricket' | 'gotcha' | 'golf' | 'shanghai' | 'killer' | 'evenodd';

const GAME_LABELS: Record<GameType, string> = {
  x01: 'X01',
  cricket: 'Cricket',
  gotcha: 'Gotcha',
  golf: 'Golf',
  shanghai: 'Shanghai',
  killer: 'Killer',
  evenodd: 'Even/Odd',
};

const gameType = ref<GameType>('x01');
const selected = ref<string[]>([]);
const playerFilter = ref('');

const filteredProfiles = computed(() => {
  const q = playerFilter.value.trim().toLowerCase();
  const unselected = store.profiles.filter((p) => !selected.value.includes(p.id));
  return q ? unselected.filter((p) => p.name.toLowerCase().includes(q)) : unselected;
});

const selectedProfiles = computed(() =>
  selected.value
    .map((id) => store.profiles.find((p) => p.id === id))
    .filter((p): p is (typeof store.profiles)[number] => !!p),
);

// X01
const startScore = ref(501);
const inMode = ref<'straight' | 'double' | 'master'>('straight');
const outMode = ref<'straight' | 'double' | 'master'>('straight');
const legsToWin = ref(1);
const setsToWin = ref(1);
// Empty means no cap, which is why this is null rather than 0 -- see the
// roundLimit note in @darts/schema. An emptied number input hands back '', so
// the config is built from the normalised value, never the raw ref.
const roundLimit = ref<number | null>(null);
const roundLimitValue = computed<number | null>(() => {
  const n = Number(roundLimit.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
});
const legEnd = ref<'first' | 'all-but-one'>('first');

/** Per-player handicaps: an override of start score and/or in-out rules. */
const handicaps = ref<Record<string, { startScore?: number; inMode?: string; outMode?: string }>>({});
/** Opt-in: pre-fill each selected player's startScore from their X01 skill handicap. */
const useX01Handicaps = ref(false);
const x01History = ref<Record<string, ModeHandicap>>({});

// Cricket
const variant = ref<'standard' | 'cutthroat'>('standard');

// Golf
const holes = ref(18);
/**
 * Each player's handicap, as computed from their past rounds. Fetched rather
 * than guessed, and editable -- the number sent with the match is what the
 * round is played off, and the server fills in anyone left out.
 */
const golfHandicaps = ref<Record<string, number>>({});
const golfHistory = ref<Record<string, GolfHandicap>>({});

// Gotcha
const target = ref(301);
const knockback = ref<'zero' | 'previousTurn'>('zero');
const exactFinish = ref(true);
/** Opt-in: pre-fill each selected player's head start from their Gotcha skill handicap. */
const useGotchaHandicaps = ref(false);
const gotchaHandicaps = ref<Record<string, number>>({});
const gotchaHistory = ref<Record<string, ModeHandicap>>({});

// Shanghai
const startRound = ref(1);
const endRound = ref(7);
const instantWin = ref(true);

// Even/Odd
const startingScore = ref(0);
const targetScore = ref(100);

// Killer
const startingLives = ref(3);
const friendlyFire = ref(false);
/** Opt-in: pre-fill each selected player's starting lives from their Killer skill handicap. */
const useKillerHandicaps = ref(false);
const killerHandicaps = ref<Record<string, number>>({});
const killerHistory = ref<Record<string, ModeHandicap>>({});

/** Whether the manual for the currently selected game is open. */
const showManual = ref(false);

const busy = ref(false);
const error = ref<string | null>(null);

const canStart = computed(() => selected.value.length > 0 && !busy.value);

function toggle(id: string): void {
  const i = selected.value.indexOf(id);
  if (i >= 0) {
    selected.value.splice(i, 1);
    delete handicaps.value[id];
  } else {
    selected.value.push(id);
  }
}

/**
 * Look up the golf handicaps of everyone selected.
 *
 * Done here rather than at start time so the players can see what they will be
 * playing off -- and adjust it -- before a dart is thrown.
 */
async function loadHandicaps(): Promise<void> {
  if (gameType.value !== 'golf') return;
  await Promise.all(
    selected.value.map(async (id) => {
      if (golfHistory.value[id]) return;
      try {
        const h = await api.handicap(id);
        golfHistory.value[id] = h;
        golfHandicaps.value[id] ??= h.handicap;
      } catch {
        // A handicap we cannot fetch simply falls back to the newcomer's 36,
        // which the server applies anyway.
      }
    }),
  );
}

/**
 * Look up the opt-in X01/Gotcha/Killer skill handicap of everyone selected,
 * mapped onto that mode's own knob using its currently configured base value.
 */
async function loadModeHandicaps(
  enabled: boolean,
  mode: 'x01' | 'gotcha' | 'killer',
  base: number,
  history: Record<string, ModeHandicap>,
  apply: (id: string, h: ModeHandicap) => void,
): Promise<void> {
  if (!enabled) return;
  await Promise.all(
    selected.value.map(async (id) => {
      if (history[id]) return;
      try {
        const h = await api.modeHandicap(id, mode, base);
        history[id] = h;
        apply(id, h);
      } catch {
        // A handicap we cannot fetch simply leaves that player at the mode's
        // own default -- the same as not opting in at all.
      }
    }),
  );
}

async function loadX01Handicaps(): Promise<void> {
  await loadModeHandicaps(useX01Handicaps.value, 'x01', startScore.value, x01History.value, (id, h) => {
    handicapFor(id).startScore ??= h.handicap;
  });
}

async function loadGotchaHandicaps(): Promise<void> {
  await loadModeHandicaps(useGotchaHandicaps.value, 'gotcha', target.value, gotchaHistory.value, (id, h) => {
    gotchaHandicaps.value[id] ??= h.handicap;
  });
}

async function loadKillerHandicaps(): Promise<void> {
  await loadModeHandicaps(useKillerHandicaps.value, 'killer', startingLives.value, killerHistory.value, (id, h) => {
    killerHandicaps.value[id] ??= h.handicap;
  });
}

watch([gameType, selected], loadHandicaps, { deep: true, immediate: true });
watch([useX01Handicaps, selected], loadX01Handicaps, { deep: true });
watch([useGotchaHandicaps, selected], loadGotchaHandicaps, { deep: true });
watch([useKillerHandicaps, selected], loadKillerHandicaps, { deep: true });

// -- reusing the previous match's settings ---------------------------------

const lastError = ref<string | null>(null);

/**
 * Fill the form from the last match played, players included.
 *
 * Everything is dropped into the same fields rather than started directly, so
 * the settings can still be adjusted before the throw.
 */
async function useLastSettings(): Promise<void> {
  lastError.value = null;
  try {
    const setup = await api.matchSetup('last');
    const cfg = setup.config as Record<string, unknown>;
    gameType.value = setup.gameType as GameType;
    selected.value = setup.playerIds.filter((id) => store.profiles.some((p) => p.id === id));

    legsToWin.value = Number(cfg.legsToWin ?? 1);
    setsToWin.value = Number(cfg.setsToWin ?? 1);
    roundLimit.value = (cfg.roundLimit as number | null) ?? null;

    if (setup.gameType === 'x01') {
      startScore.value = Number(cfg.startScore ?? 501);
      inMode.value = (cfg.inMode as typeof inMode.value) ?? 'straight';
      outMode.value = (cfg.outMode as typeof outMode.value) ?? 'straight';
      legEnd.value = (cfg.legEnd as typeof legEnd.value) ?? 'first';
      handicaps.value = { ...((cfg.perPlayer as Record<string, never>) ?? {}) };
      // Handicaps are opt-in per match, not carried over -- see the Golf note below.
      useX01Handicaps.value = false;
      x01History.value = {};
    }
    if (setup.gameType === 'cricket') variant.value = (cfg.variant as typeof variant.value) ?? 'standard';
    if (setup.gameType === 'gotcha') {
      target.value = Number(cfg.target ?? 301);
      knockback.value = (cfg.knockback as typeof knockback.value) ?? 'zero';
      exactFinish.value = cfg.exactFinish !== false;
      useGotchaHandicaps.value = false;
      gotchaHandicaps.value = {};
      gotchaHistory.value = {};
    }
    if (setup.gameType === 'shanghai') {
      startRound.value = Number(cfg.startRound ?? 1);
      endRound.value = Number(cfg.endRound ?? 7);
      instantWin.value = cfg.instantWin !== false;
    }
    if (setup.gameType === 'evenodd') {
      startingScore.value = Number(cfg.startingScore ?? 0);
      targetScore.value = Number(cfg.targetScore ?? 100);
    }
    if (setup.gameType === 'killer') {
      startingLives.value = Number(cfg.startingLives ?? 3);
      friendlyFire.value = cfg.friendlyFire === true;
      useKillerHandicaps.value = false;
      killerHandicaps.value = {};
      killerHistory.value = {};
    }
    if (setup.gameType === 'golf') {
      holes.value = Number(cfg.holes ?? 18);
      // Handicaps are deliberately NOT carried over: they move with each round
      // played, and reusing a stale one would misprice the game.
      golfHandicaps.value = {};
      golfHistory.value = {};
      await loadHandicaps();
    }
  } catch (err) {
    lastError.value = (err as Error).message;
  }
}

/** How the player's last round moved their handicap, as a signed figure. */
function lastGolfMove(id: string): string {
  const adjustment = golfHistory.value[id]?.recent[0]?.adjustment ?? 0;
  if (adjustment === 0) return 'level';
  return adjustment > 0 ? `+${adjustment}` : String(adjustment);
}

function handicapFor(id: string) {
  handicaps.value[id] ??= {};
  return handicaps.value[id]!;
}

function buildConfig(): unknown {
  if (gameType.value === 'cricket') {
    return {
      gameType: 'cricket',
      variant: variant.value,
      targets: [20, 19, 18, 17, 16, 15, 25],
      scoring: true,
      legsToWin: legsToWin.value,
      setsToWin: setsToWin.value,
      roundLimit: roundLimitValue.value,
    };
  }
  if (gameType.value === 'golf') {
    return {
      gameType: 'golf',
      holes: holes.value,
      par: 4,
      handicaps: Object.fromEntries(
        selected.value
          .filter((id) => typeof golfHandicaps.value[id] === 'number')
          .map((id) => [id, golfHandicaps.value[id]]),
      ),
      legsToWin: 1,
      setsToWin: 1,
      roundLimit: roundLimitValue.value,
    };
  }
  if (gameType.value === 'gotcha') {
    return {
      gameType: 'gotcha',
      target: target.value,
      knockback: knockback.value,
      exactFinish: exactFinish.value,
      handicaps: useGotchaHandicaps.value
        ? Object.fromEntries(
            selected.value
              .filter((id) => typeof gotchaHandicaps.value[id] === 'number')
              .map((id) => [id, gotchaHandicaps.value[id]]),
          )
        : {},
      legsToWin: legsToWin.value,
      setsToWin: setsToWin.value,
      roundLimit: roundLimitValue.value,
    };
  }
  if (gameType.value === 'shanghai') {
    return {
      gameType: 'shanghai',
      startRound: startRound.value,
      endRound: endRound.value,
      instantWin: instantWin.value,
      legsToWin: legsToWin.value,
      setsToWin: setsToWin.value,
      roundLimit: roundLimitValue.value,
    };
  }
  if (gameType.value === 'evenodd') {
    return {
      gameType: 'evenodd',
      startingScore: startingScore.value,
      targetScore: targetScore.value,
      legsToWin: legsToWin.value,
      setsToWin: setsToWin.value,
      roundLimit: roundLimitValue.value,
    };
  }
  if (gameType.value === 'killer') {
    return {
      gameType: 'killer',
      startingLives: startingLives.value,
      friendlyFire: friendlyFire.value,
      handicaps: useKillerHandicaps.value
        ? Object.fromEntries(
            selected.value
              .filter((id) => typeof killerHandicaps.value[id] === 'number')
              .map((id) => [id, killerHandicaps.value[id]]),
          )
        : {},
      legsToWin: legsToWin.value,
      setsToWin: setsToWin.value,
      roundLimit: roundLimitValue.value,
    };
  }

  const perPlayer: Record<string, unknown> = {};
  for (const id of selected.value) {
    const h = handicaps.value[id];
    if (!h) continue;
    const entry: Record<string, unknown> = {};
    if (h.startScore) entry.startScore = h.startScore;
    if (h.inMode) entry.inMode = h.inMode;
    if (h.outMode) entry.outMode = h.outMode;
    if (Object.keys(entry).length > 0) perPlayer[id] = entry;
  }

  return {
    gameType: 'x01',
    startScore: startScore.value,
    inMode: inMode.value,
    outMode: outMode.value,
    legsToWin: legsToWin.value,
    setsToWin: setsToWin.value,
    roundLimit: roundLimitValue.value,
    legEnd: legEnd.value,
    perPlayer,
  };
}

async function start(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await api.startMatch(buildConfig(), selected.value);
    emit('started');
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="setup">
    <div class="head">
      <h2>New match</h2>
      <button class="ghost" @click="useLastSettings">Use last game's settings</button>
    </div>
    <p v-if="lastError" class="hint">Could not load the last match: {{ lastError }}</p>

    <div class="field">
      <div class="field-head">
        <label>Game</label>
        <button class="ghost manual-btn" @click="showManual = true">
          {{ GAME_LABELS[gameType] }} manual
        </button>
      </div>
      <div class="tabs">
        <button
          v-for="g in (['x01', 'cricket', 'gotcha', 'golf', 'shanghai', 'killer', 'evenodd'] as GameType[])"
          :key="g"
          :class="{ on: gameType === g }"
          @click="gameType = g"
        >{{ GAME_LABELS[g] }}</button>
      </div>
    </div>

    <GameManual
      v-if="showManual"
      :game-type="gameType"
      :label="GAME_LABELS[gameType]"
      @close="showManual = false"
    />

    <div class="field">
      <label>Players</label>
      <p v-if="store.profiles.length === 0" class="hint">
        No profiles yet &mdash; add one below.
      </p>
      <template v-else>
        <input
          v-model="playerFilter"
          type="text"
          class="player-search"
          placeholder="Search players&hellip;"
          autocomplete="off"
        />
        <div class="chips scroll">
          <button
            v-for="p in filteredProfiles"
            :key="p.id"
            class="chip"
            :style="{ '--accent': p.color }"
            @click="toggle(p.id)"
          >{{ p.name }}</button>
          <p v-if="filteredProfiles.length === 0" class="hint">No matching players.</p>
        </div>
        <div v-if="selectedProfiles.length" class="chips selected-chips">
          <button
            v-for="p in selectedProfiles"
            :key="p.id"
            class="chip on"
            :style="{ '--accent': p.color }"
            @click="toggle(p.id)"
          >{{ p.name }}</button>
        </div>
      </template>
    </div>

    <!-- X01 -->
    <template v-if="gameType === 'x01'">
      <div class="grid">
        <div class="field">
          <label>Start score</label>
          <select v-model.number="startScore">
            <option :value="170">170</option>
            <option :value="301">301</option>
            <option :value="501">501</option>
            <option :value="701">701</option>
          </select>
        </div>
        <div class="field">
          <label>In</label>
          <select v-model="inMode">
            <option value="straight">Straight</option>
            <option value="double">Double</option>
            <option value="master">Master</option>
          </select>
        </div>
        <div class="field">
          <label>Out</label>
          <select v-model="outMode">
            <option value="straight">Straight</option>
            <option value="double">Double</option>
            <option value="master">Master</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Leg ends</label>
        <select v-model="legEnd">
          <option value="first">When the first player checks out</option>
          <option value="all-but-one">When all but one player has checked out</option>
        </select>
        <p v-if="legEnd === 'all-but-one'" class="hint">
          Play continues after the first checkout so everyone gets a finishing
          place. The leg is still won by whoever went out first. With two
          players this makes no difference.
        </p>
      </div>

      <details v-if="selected.length > 0" class="handicaps">
        <summary>Per-player handicaps</summary>
        <label class="use-handicaps">
          <input v-model="useX01Handicaps" type="checkbox" />
          Suggest a start score from each player's recent X01 average
        </label>
        <p class="hint">
          Override the start score or the in/out rule for individual players, so a
          stronger player can play 501 double-out against 301 straight-out.
        </p>
        <div
          v-for="id in selected"
          :key="id"
          class="handicap-row"
        >
          <span class="who">{{ store.profiles.find((p) => p.id === id)?.name }}</span>
          <select v-model.number="handicapFor(id).startScore">
            <option :value="undefined">default ({{ startScore }})</option>
            <option :value="170">170</option>
            <option :value="301">301</option>
            <option :value="501">501</option>
            <option :value="701">701</option>
          </select>
          <select v-model="handicapFor(id).inMode">
            <option :value="undefined">in: default</option>
            <option value="straight">in: straight</option>
            <option value="double">in: double</option>
            <option value="master">in: master</option>
          </select>
          <select v-model="handicapFor(id).outMode">
            <option :value="undefined">out: default</option>
            <option value="straight">out: straight</option>
            <option value="double">out: double</option>
            <option value="master">out: master</option>
          </select>
          <span v-if="useX01Handicaps" class="hint">
            <template v-if="x01History[id]?.matches">
              suggested {{ x01History[id]?.handicap }} ({{ x01History[id]?.counted }} of
              {{ x01History[id]?.matches }} matches)
            </template>
            <template v-else>no matches yet &mdash; no adjustment</template>
          </span>
        </div>
      </details>
    </template>

    <!-- Cricket -->
    <div v-else-if="gameType === 'cricket'" class="field">
      <label>Variant</label>
      <select v-model="variant">
        <option value="standard">Standard &mdash; highest score wins</option>
        <option value="cutthroat">Cut-throat &mdash; points go to opponents, lowest wins</option>
      </select>
    </div>

    <!-- Golf -->
    <template v-else-if="gameType === 'golf'">
      <div class="field">
        <label>Holes</label>
        <select v-model.number="holes">
          <option :value="9">9 holes</option>
          <option :value="18">18 holes</option>
        </select>
        <p class="hint">
          Hole 1 is the board's 1, hole 2 the 2, and so on. Every dart is a
          stroke and the hole is holed the moment you hit that number in any
          ring. Par is 4, plus your handicap strokes; one over par abandons the
          hole for nothing.
        </p>
      </div>

      <div v-if="selected.length" class="field">
        <label>Handicaps</label>
        <p class="hint">
          Carried on from each player's last round: every ten points clear of
          the par target takes a stroke off, every ten short puts one back on.
          A player with no rounds behind them starts on 36, which is what
          playing every hole to par is worth.
        </p>
        <div v-for="id in selected" :key="id" class="handicap-row golf-row">
          <span class="who">{{ store.profiles.find((p) => p.id === id)?.name }}</span>
          <input
            v-model.number="golfHandicaps[id]"
            type="number"
            min="0"
            max="36"
            :placeholder="String(golfHistory[id]?.handicap ?? 36)"
          />
          <span class="hint">
            <template v-if="golfHistory[id]?.rounds">
              {{ golfHistory[id]?.rounds }} rounds played, last one {{ lastGolfMove(id) }}
            </template>
            <template v-else>no rounds yet &mdash; starts on 36</template>
          </span>
        </div>
      </div>
    </template>

    <!-- Shanghai -->
    <template v-else-if="gameType === 'shanghai'">
      <div class="grid">
        <div class="field">
          <label>From round</label>
          <input v-model.number="startRound" type="number" min="1" max="20" />
        </div>
        <div class="field">
          <label>To round</label>
          <input v-model.number="endRound" type="number" min="1" max="20" />
        </div>
        <div class="field">
          <label>Instant win</label>
          <select v-model="instantWin">
            <option :value="true">On a Shanghai (single + double + triple)</option>
            <option :value="false">Off &mdash; highest score after the last round wins</option>
          </select>
        </div>
      </div>
      <p class="hint">
        Round N targets the number N &mdash; only darts on that number score.
        Everyone plays the round before it advances; highest total wins.
      </p>
    </template>

    <!-- Killer -->
    <template v-else-if="gameType === 'killer'">
      <div class="grid">
        <div class="field">
          <label>Lives</label>
          <input v-model.number="startingLives" type="number" min="1" max="9" />
        </div>
        <div class="field">
          <label>Friendly fire</label>
          <select v-model="friendlyFire">
            <option :value="false">Off</option>
            <option :value="true">On &mdash; hitting your own number after becoming a killer costs a third of a life
            </option>
          </select>
        </div>
      </div>
      <p class="hint">
        Each player throws for a number of their own, then needs three hits on it
        &mdash; a triple counts as three &mdash; to become a killer. After that
        every hit on an opponent's number takes a third of a life off them. Last
        player standing wins.
      </p>

      <details v-if="selected.length > 0" class="handicaps">
        <summary>Per-player handicaps</summary>
        <label class="use-handicaps">
          <input v-model="useKillerHandicaps" type="checkbox" />
          Suggest extra starting lives for weaker players, from their recent Killer average
        </label>
        <template v-if="useKillerHandicaps">
          <div v-for="id in selected" :key="id" class="handicap-row golf-row">
            <span class="who">{{ store.profiles.find((p) => p.id === id)?.name }}</span>
            <input
              v-model.number="killerHandicaps[id]"
              type="number"
              min="1"
              max="9"
              :placeholder="String(killerHistory[id]?.handicap ?? startingLives)"
            />
            <span class="hint">
              <template v-if="killerHistory[id]?.matches">
                {{ killerHistory[id]?.counted }} of {{ killerHistory[id]?.matches }} matches counted
              </template>
              <template v-else>no matches yet &mdash; no adjustment</template>
            </span>
          </div>
        </template>
      </details>
    </template>

    <!-- Even/Odd -->
    <template v-else-if="gameType === 'evenodd'">
      <div class="grid">
        <div class="field">
          <label>Starting score</label>
          <input v-model.number="startingScore" type="number" />
        </div>
        <div class="field">
          <label>Target score</label>
          <input v-model.number="targetScore" type="number" min="1" />
        </div>
      </div>
      <p class="hint">
        Even numbers add their scored value, odd numbers subtract it &mdash;
        the inner bull counts as even, the outer bull as odd. First to reach
        or cross the target score wins the leg.
      </p>
    </template>

    <!-- Gotcha -->
    <template v-else>
      <div class="grid">
        <div class="field">
          <label>Target</label>
          <select v-model.number="target">
            <option :value="201">201</option>
            <option :value="301">301</option>
            <option :value="501">501</option>
          </select>
        </div>
        <div class="field">
          <label>Knock-back</label>
          <select v-model="knockback">
            <option value="zero">Back to zero</option>
            <option value="previousTurn">Back to previous turn</option>
          </select>
        </div>
        <div class="field">
          <label>Finish</label>
          <select v-model="exactFinish">
            <option :value="true">Exact target</option>
            <option :value="false">Reach or pass</option>
          </select>
        </div>
      </div>

      <details v-if="selected.length > 0" class="handicaps">
        <summary>Per-player handicaps</summary>
        <label class="use-handicaps">
          <input v-model="useGotchaHandicaps" type="checkbox" />
          Suggest a head start for weaker players, from their recent Gotcha average
        </label>
        <template v-if="useGotchaHandicaps">
          <div v-for="id in selected" :key="id" class="handicap-row golf-row">
            <span class="who">{{ store.profiles.find((p) => p.id === id)?.name }}</span>
            <input
              v-model.number="gotchaHandicaps[id]"
              type="number"
              min="0"
              :max="target - 1"
              :placeholder="String(gotchaHistory[id]?.handicap ?? 0)"
            />
            <span class="hint">
              <template v-if="gotchaHistory[id]?.matches">
                {{ gotchaHistory[id]?.counted }} of {{ gotchaHistory[id]?.matches }} matches counted
              </template>
              <template v-else>no matches yet &mdash; no adjustment</template>
            </span>
          </div>
        </template>
      </details>
    </template>

    <div v-if="gameType !== 'golf'" class="grid">
      <div class="field">
        <label>Legs to win</label>
        <input v-model.number="legsToWin" type="number" min="1" max="21" />
      </div>
      <div class="field">
        <label>Sets to win</label>
        <input v-model.number="setsToWin" type="number" min="1" max="11" />
      </div>
    </div>

    <!--
      Every game gets a round limit, golf included: it is the escape hatch for a
      leg that would otherwise run all night. Left empty it does nothing.
    -->
    <div class="field">
      <label>Round limit</label>
      <input v-model.number="roundLimit" type="number" min="1" max="99" placeholder="no limit" />
      <p class="hint">A round is a turn each. At the limit the leg goes to whoever leads.</p>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <button class="primary" :disabled="!canStart" @click="start">Start match</button>
  </section>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; gap: 1rem; }
h2 { margin: 0; font-size: 1.1rem; }
.head { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.head .ghost {
  margin-left: auto; background: none; border: 1px solid #333b49; color: #cdd3dc;
  border-radius: 999px; padding: 0.3rem 0.85rem; cursor: pointer; font: inherit; font-size: 0.8rem;
}
.head .ghost:hover { border-color: #4f8ef7; color: #fff; }
.field-head { display: flex; align-items: center; gap: 0.75rem; }
.manual-btn {
  margin-left: auto; background: none; border: 1px solid #333b49; color: #cdd3dc;
  border-radius: 999px; padding: 0.25rem 0.75rem; cursor: pointer; font: inherit; font-size: 0.78rem;
}
.manual-btn:hover { border-color: #4f8ef7; color: #fff; }
.golf-row { grid-template-columns: 7rem 5rem 1fr; }
.field { display: flex; flex-direction: column; gap: 0.35rem; }
label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.07em; color: #8b93a1; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.75rem; }
.hint { margin: 0; font-size: 0.8rem; color: #8b93a1; }
.tabs, .chips { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.player-search { width: 100%; box-sizing: border-box; }
.selected-chips { padding-bottom: 0.5rem; border-bottom: 1px solid #262b33; }
.chips.scroll {
  max-height: 14rem; overflow-y: auto; align-content: flex-start;
  padding-top: 0.15rem;
}
.chips.scroll .hint { flex-basis: 100%; }
.tabs button, .chip {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 999px; padding: 0.4rem 0.9rem; cursor: pointer;
}
.tabs button.on { background: #2b3240; border-color: #4f8ef7; color: #fff; }
.chip.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, #14171c); color: #fff; }
select, input {
  background: #14171c; border: 1px solid #262b33; color: #e8e6e1;
  border-radius: 6px; padding: 0.45rem 0.6rem; font: inherit;
}
.handicaps { border: 1px solid #262b33; border-radius: 8px; padding: 0.75rem; }
summary { cursor: pointer; font-size: 0.9rem; }
.use-handicaps {
  display: flex; align-items: center; gap: 0.5rem; margin-top: 0.6rem;
  font-size: 0.85rem; cursor: pointer;
}
.handicap-row {
  display: grid; grid-template-columns: 7rem repeat(3, 1fr);
  gap: 0.5rem; align-items: center; margin-top: 0.6rem;
}
.who { font-weight: 600; }
.primary {
  background: #4f8ef7; border: none; color: #fff; font-weight: 600;
  border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; font-size: 1rem;
}
.primary:disabled { opacity: 0.45; cursor: not-allowed; }
.error { color: #d8453f; margin: 0; font-size: 0.85rem; }
</style>
