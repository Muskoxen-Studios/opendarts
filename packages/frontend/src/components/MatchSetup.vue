<script setup lang="ts">
import PlayerAvatar from './PlayerAvatar.vue';
import { computed, reactive, ref, watch } from 'vue';
import { minefieldHitPoints } from '@darts/schema';
import { api, store, type GolfHandicap, type ModeHandicap } from '../store.ts';
import GameManual from './GameManual.vue';

const emit = defineEmits<{ (e: 'started'): void }>();

type GameType = 'x01' | 'cricket' | 'gotcha' | 'golf' | 'shanghai' | 'killer' | 'evenodd' | 'minefield' | 'conquest' | 'countup' | 'aroundtheclock' | 'randomcheckout' | 'roundtheworld' | 'segmenttraining' | 'bobs27' | '121';

const GAME_LABELS: Record<GameType, string> = {
  x01: 'X01',
  cricket: 'Cricket',
  gotcha: 'Gotcha',
  golf: 'Golf',
  shanghai: 'Shanghai',
  killer: 'Killer',
  evenodd: 'Even/Odd',
  minefield: 'Minefield',
  conquest: 'Conquest',
  countup: 'Count Up',
  aroundtheclock: 'Around the Clock',
  randomcheckout: 'Random Checkout',
  roundtheworld: 'Round the World',
  segmenttraining: 'Segment Training',
  bobs27: "Bob's 27",
  '121': '121',
};

const gameType = ref<GameType>('x01');
type GameCategory = 'tournament' | 'party' | 'training' | 'experimental';
const gameCategories: Array<{ id: GameCategory; label: string; games: GameType[] }> = [
  { id: 'tournament', label: 'Tournament', games: ['x01', 'cricket', 'golf'] },
  { id: 'party', label: 'Party', games: ['gotcha', 'shanghai', 'killer', 'evenodd'] },
  { id: 'training', label: 'Training', games: ['countup', 'aroundtheclock', 'randomcheckout', 'roundtheworld', 'segmenttraining', 'bobs27', '121'] },
  { id: 'experimental', label: 'Experimental', games: ['minefield', 'conquest'] },
];
const activeCategory = computed(() => gameCategories.find(c => c.games.includes(gameType.value)) ?? gameCategories[0]!);

function selectCategory(id: GameCategory): void {
  const category = gameCategories.find(c => c.id === id)!;
  if (category.id !== activeCategory.value.id) gameType.value = category.games[0]!;
}

function categoryKey(event: KeyboardEvent, index: number): void {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % gameCategories.length;
  else if (event.key === 'ArrowLeft') next = (index + gameCategories.length - 1) % gameCategories.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = gameCategories.length - 1;
  else return;
  event.preventDefault();
  selectCategory(gameCategories[next]!.id);
  document.getElementById(`game-category-${gameCategories[next]!.id}`)?.focus();
}
const selected = ref<string[]>([]);
const playerFilter = ref('');
const draggedPlayer = ref<string | null>(null);
let dragPointer: number | null = null;
let orderBeforeDrag: string[] | null = null;

function movePlayer(id: string, target: number): void {
  const from = selected.value.indexOf(id);
  if (from < 0 || target < 0 || target >= selected.value.length || from === target) return;
  const order = [...selected.value];
  order.splice(from, 1);
  order.splice(target, 0, id);
  selected.value = order;
}

function startPlayerDrag(event: PointerEvent, id: string): void {
  if (event.button !== 0 || draggedPlayer.value || busy.value || loadingLast.value || selected.value.length < 2) return;
  const list = (event.currentTarget as HTMLElement).closest('ol');
  if (!list) return;
  event.preventDefault();
  list.setPointerCapture(event.pointerId);
  dragPointer = event.pointerId;
  orderBeforeDrag = [...selected.value];
  draggedPlayer.value = id;
}

function dragPlayer(event: PointerEvent): void {
  if (!draggedPlayer.value || event.pointerId !== dragPointer) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-player-id]');
  if (!target || !event.currentTarget || !(event.currentTarget as HTMLElement).contains(target)) return;
  movePlayer(draggedPlayer.value, selected.value.indexOf(target.dataset.playerId ?? ''));
}

function finishPlayerDrag(): void {
  draggedPlayer.value = null;
  dragPointer = null;
  orderBeforeDrag = null;
}

function cancelPlayerDrag(): void {
  if (orderBeforeDrag) selected.value = orderBeforeDrag;
  finishPlayerDrag();
}

function movePlayerBy(id: string, offset: number): void {
  if (!busy.value && !loadingLast.value) movePlayer(id, selected.value.indexOf(id) + offset);
}

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

// Training
const countUpRounds = ref(8);
const countUpRoundsValid = computed(() => Number.isInteger(countUpRounds.value) && countUpRounds.value >= 1 && countUpRounds.value <= 100);
const clockFinishBull = ref(true);
const clockMode = ref<'full' | 'single' | 'outer-single' | 'double' | 'triple'>('full');
const clockOrder = ref<'ascending' | 'descending' | 'random'>('ascending');
const clockHits = ref(1);
const randomCheckout = reactive({ checkoutMin: 41, checkoutMax: 100, outMode: 'double' as 'straight' | 'double' | 'master', maxRounds: 3, continuous: true });
const world = reactive({ order: 'ascending' as 'ascending' | 'descending' | 'random', finishBull: true });
const segmentPractice = reactive({ mode: 'single' as 'single' | 'outer-single' | 'double' | 'triple' | 'random', segment: 20, endsAfter: 'hits' as 'hits' | 'darts', count: 10 });
const bob = reactive({ allowNegative: false, finishBull: true });
const climb = reactive({ maxRounds: 10, dartMode: 9 as 6 | 9, onFail: 'soft' as 'soft' | 'hard' | 'safehouse', step: 1 as 1 | 3 | 5, safehouseEvery: 1 as 1 | 2 | 3 | 5 });
const trainingError = computed(() => {
  const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  if (gameType.value === 'bobs27' && selected.value.length !== 1) return "Bob's 27 requires exactly one player.";
  if (gameType.value === 'randomcheckout' && (!integer(randomCheckout.checkoutMin, 2, 180) || !integer(randomCheckout.checkoutMax, randomCheckout.checkoutMin, 180) || !integer(randomCheckout.maxRounds, 1, 100))) return 'Choose a valid checkout range (2–180) and 1–100 visits per leg.';
  if (gameType.value === 'segmenttraining' && (!integer(segmentPractice.segment, 1, 20) || !integer(segmentPractice.count, 1, 1000))) return 'Choose target 1–20 and a hit/dart count from 1–1000.';
  if (gameType.value === '121' && !integer(climb.maxRounds, 1, 100)) return 'Choose 1–100 attempts per player.';
  return null;
});

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

// Minefield
const minefieldAutoHP = ref(true);
const minefieldHP = ref(2);
const minefieldSuggestedHP = computed(() => minefieldAutoHP.value ? minefieldHitPoints(selected.value.length, minefieldHP.value) : minefieldHP.value);
const minefieldMode = ref<'normal' | 'gotcha'>('normal');
const minefieldLifetime = ref(1);
const minefieldDefusal = ref(true);
const minefieldBlastRadius = ref(false);
const minefieldResetNegative = ref(false);
const minefieldExactFinish = ref(true);
const minefieldKnockback = ref<'zero' | 'previousTurn'>('zero');
const minefieldTarget = ref(301);

// Even/Odd
const startingScore = ref(0);
const targetScore = ref(100);

// Conquest
const conquestDefeat = ref<'elimination' | 'conversion'>('elimination');
const conquestComeback = ref(false);
const conquestSplit = ref(false);
const conquestMultipliers = ref(false);
const conquestFortified = ref(false);
const conquestRosterValid = computed(() => selected.value.length >= 2 && 20 % selected.value.length === 0);

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
const loadingLast = ref(false);
const error = ref<string | null>(null);

const canStart = computed(() => selected.value.length > 0 && !busy.value && !loadingLast.value && !trainingError.value && (gameType.value !== 'conquest' || conquestRosterValid.value) && (gameType.value !== 'countup' || countUpRoundsValid.value));

function toggle(id: string): void {
  const i = selected.value.indexOf(id);
  if (i >= 0) {
    selected.value.splice(i, 1);
    delete handicaps.value[id];
  } else {
    selected.value.push(id);
  }
}

function shufflePlayers(): void {
  const order = [...selected.value];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  selected.value = order;
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

function selectPreviousPlayers(playerIds: string[]): void {
  selected.value = playerIds.filter((id) => store.profiles.some((p) => p.id === id));
  playerFilter.value = '';
}

async function useLastPlayers(): Promise<void> {
  loadingLast.value = true;
  lastError.value = null;
  try {
    const setup = await api.matchSetup('last');
    selectPreviousPlayers(setup.playerIds);
    if (!selected.value.length) lastError.value = 'None of the last game’s players are available. Select players below.';
  } catch (err) {
    lastError.value = (err as Error).message === 'no such match'
      ? 'No finished game yet. Select players below.'
      : `Could not load the last match: ${(err as Error).message}`;
  } finally {
    loadingLast.value = false;
  }
}

/**
 * Fill the form from the last match played, players included.
 *
 * Everything is dropped into the same fields rather than started directly, so
 * the settings can still be adjusted before the throw.
 */
async function useLastSettings(): Promise<void> {
  loadingLast.value = true;
  lastError.value = null;
  try {
    const setup = await api.matchSetup('last');
    const cfg = setup.config as Record<string, unknown>;
    gameType.value = setup.gameType as GameType;
    selectPreviousPlayers(setup.playerIds);
    if (setup.gameType === 'countup') countUpRounds.value = Number(cfg.rounds ?? 8);
    if (setup.gameType === 'aroundtheclock') {
      clockFinishBull.value = cfg.finishBull !== false;
      clockMode.value = (cfg.mode as typeof clockMode.value) ?? 'full';
      clockOrder.value = (cfg.order as typeof clockOrder.value) ?? 'ascending';
      clockHits.value = Number(cfg.hits ?? 1);
    }
    if (setup.gameType === 'randomcheckout') Object.assign(randomCheckout, { checkoutMin: cfg.checkoutMin ?? 41, checkoutMax: cfg.checkoutMax ?? 100, outMode: cfg.outMode ?? 'double', maxRounds: cfg.maxRounds ?? 3, continuous: cfg.continuous !== false });
    if (setup.gameType === 'roundtheworld') Object.assign(world, { order: cfg.order ?? 'ascending', finishBull: cfg.finishBull !== false });
    if (setup.gameType === 'segmenttraining') Object.assign(segmentPractice, { mode: cfg.mode ?? 'single', segment: cfg.segment ?? 20, endsAfter: cfg.endsAfter ?? 'hits', count: cfg.count ?? 10 });
    if (setup.gameType === 'bobs27') Object.assign(bob, { allowNegative: cfg.allowNegative === true, finishBull: cfg.finishBull !== false });
    if (setup.gameType === '121') Object.assign(climb, { maxRounds: cfg.maxRounds ?? 10, dartMode: cfg.dartMode ?? 9, onFail: cfg.onFail ?? 'soft', step: cfg.step ?? 1, safehouseEvery: cfg.safehouseEvery ?? 1 });

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
    if (setup.gameType === 'conquest') {
      conquestDefeat.value = cfg.defeatMode === 'conversion' ? 'conversion' : 'elimination';
      conquestComeback.value = cfg.comebackFoothold === true;
      conquestSplit.value = cfg.splitTerritories === true;
      conquestMultipliers.value = cfg.multipliers === true;
      conquestFortified.value = cfg.fortifiedHomes === true;
    }
    if (setup.gameType === 'minefield') {
      minefieldAutoHP.value = cfg.hitPoints == null;
      minefieldHP.value = Number(cfg.hitPoints ?? cfg.hitPointsPerPlayer ?? 2);
      minefieldTarget.value = Number(cfg.targetScore ?? 301);
      minefieldMode.value = cfg.mode === 'gotcha' ? 'gotcha' : 'normal';
      minefieldLifetime.value = Number(cfg.mineLifetime ?? 1);
      minefieldDefusal.value = cfg.defusal !== false;
      minefieldBlastRadius.value = cfg.blastRadius === true;
      minefieldResetNegative.value = cfg.resetNegative === true;
      minefieldExactFinish.value = cfg.exactFinish !== false;
      minefieldKnockback.value = cfg.knockback === 'previousTurn' ? 'previousTurn' : 'zero';
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
    lastError.value = (err as Error).message === 'no such match'
      ? 'No finished game yet. Select players below.'
      : `Could not load the last match: ${(err as Error).message}`;
  } finally {
    loadingLast.value = false;
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
  if (gameType.value === 'countup') return {
    gameType: 'countup', rounds: countUpRounds.value,
    legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value,
  };
  if (gameType.value === 'aroundtheclock') return {
    gameType: 'aroundtheclock', finishBull: clockFinishBull.value, mode: clockMode.value, order: clockOrder.value, hits: clockHits.value,
    legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value,
  };
  if (gameType.value === 'randomcheckout') return { gameType: 'randomcheckout', ...randomCheckout, legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value };
  if (gameType.value === 'roundtheworld') return { gameType: 'roundtheworld', ...world, legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value };
  if (gameType.value === 'segmenttraining') return { gameType: 'segmenttraining', ...segmentPractice, legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value };
  if (gameType.value === 'bobs27') return { gameType: 'bobs27', ...bob, legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value };
  if (gameType.value === '121') return { gameType: '121', ...climb, legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value };
  if (gameType.value === 'conquest') return {
    gameType: 'conquest', defeatMode: conquestDefeat.value,
    comebackFoothold: conquestComeback.value, splitTerritories: conquestSplit.value,
    multipliers: conquestMultipliers.value, fortifiedHomes: conquestFortified.value,
    legsToWin: legsToWin.value, setsToWin: setsToWin.value, roundLimit: roundLimitValue.value,
  };

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
  if (gameType.value === 'minefield') {
    return {
      gameType: 'minefield',
      hitPoints: minefieldAutoHP.value ? null : minefieldHP.value,
      hitPointsPerPlayer: minefieldAutoHP.value ? minefieldHP.value : 2,
      targetScore: minefieldTarget.value,
      mode: minefieldMode.value,
      mineLifetime: minefieldLifetime.value,
      defusal: minefieldDefusal.value,
      blastRadius: minefieldBlastRadius.value,
      resetNegative: minefieldResetNegative.value,
      exactFinish: minefieldExactFinish.value,
      knockback: minefieldKnockback.value,
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
      <div class="page-heading"><p class="page-eyebrow">Set the stage</p><h2>New match</h2><p class="page-description">Your players. Your rules. A fresh challenge.</p></div>
      <button class="ghost" :disabled="busy || loadingLast" @click="useLastSettings">Use last game's settings</button>
    </div>
    <p v-if="lastError" class="hint" role="status">{{ lastError }}</p>

    <div class="field">
      <div class="field-head">
        <label>Game</label>
        <button class="ghost manual-btn" @click="showManual = true">
          {{ GAME_LABELS[gameType] }} manual
        </button>
      </div>
      <div class="game-categories" role="tablist" aria-label="Game categories">
        <button v-for="(category, index) in gameCategories" :id="`game-category-${category.id}`" :key="category.id"
          type="button" role="tab" :aria-selected="activeCategory.id === category.id"
          :aria-controls="`game-panel-${category.id}`" :tabindex="activeCategory.id === category.id ? 0 : -1"
          :class="{ on: activeCategory.id === category.id }" @click="selectCategory(category.id)"
          @keydown="categoryKey($event, index)">{{ category.label }}</button>
      </div>
      <div v-for="category in gameCategories" :id="`game-panel-${category.id}`" :key="category.id"
        v-show="activeCategory.id === category.id" class="tabs" role="tabpanel" :aria-labelledby="`game-category-${category.id}`">
        <button
          v-for="g in category.games"
          :key="g"
          :class="{ on: gameType === g }"
          :aria-pressed="gameType === g"
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
      <div class="field-head player-heading">
        <label>Players</label>
        <div class="player-actions">
          <button class="ghost manual-btn" :disabled="busy || loadingLast" @click="useLastPlayers">{{ loadingLast ? 'Loading…' : "Use last game's players" }}</button>
          <button class="ghost manual-btn" :disabled="busy || loadingLast || selected.length < 2" @click="shufflePlayers">Shuffle players</button>
        </div>
      </div>
      <p v-if="store.profiles.length === 0" class="hint">
        No profiles yet &mdash; add one below.
      </p>
      <template v-else>
        <p v-if="selectedProfiles.length" id="player-order-help" class="hint">Throwing order · drag a handle to reorder, or focus it and use the arrow keys.</p>
        <ol v-if="selectedProfiles.length" class="chips selected-chips" aria-label="Selected players in throwing order"
          @pointermove="dragPlayer" @pointerup="finishPlayerDrag" @pointercancel="cancelPlayerDrag"
          @lostpointercapture="cancelPlayerDrag" @keydown.esc="cancelPlayerDrag">
          <li v-for="(p, index) in selectedProfiles" :key="p.id" class="chip on selected-player"
            :class="{ dragging: draggedPlayer === p.id }" :data-player-id="p.id" :style="{ '--accent': p.color }">
            <button type="button" class="drag-handle" :disabled="busy || loadingLast || selected.length < 2"
              :aria-label="`Reorder ${p.name}, position ${index + 1} of ${selectedProfiles.length}`" aria-describedby="player-order-help"
              @pointerdown="startPlayerDrag($event, p.id)"
              @keydown.left.prevent="movePlayerBy(p.id, -1)" @keydown.up.prevent="movePlayerBy(p.id, -1)"
              @keydown.right.prevent="movePlayerBy(p.id, 1)" @keydown.down.prevent="movePlayerBy(p.id, 1)"><span aria-hidden="true">⠿</span></button>
            <span class="player-order">{{ index + 1 }}.</span>
            <PlayerAvatar :player-id="p.id" /><span>{{ p.name }}</span>
            <button type="button" class="remove-player" :disabled="busy || loadingLast" :aria-label="`Remove ${p.name}`" @click="toggle(p.id)">×</button>
          </li>
        </ol>
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
          ><PlayerAvatar :player-id="p.id" />{{ p.name }}</button>
          <p v-if="filteredProfiles.length === 0" class="hint">{{ playerFilter.trim() ? 'No matching players.' : 'All players are selected.' }}</p>
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
          <span class="who"><PlayerAvatar :player-id="id" />{{ store.profiles.find((p) => p.id === id)?.name }}</span>
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
          <span class="who"><PlayerAvatar :player-id="id" />{{ store.profiles.find((p) => p.id === id)?.name }}</span>
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
            <span class="who"><PlayerAvatar :player-id="id" />{{ store.profiles.find((p) => p.id === id)?.name }}</span>
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

    <!-- Minefield -->
    <template v-else-if="gameType === 'minefield'">
      <div class="grid">
        <div class="field">
          <label for="minefield-mode">Scoring mode</label>
          <select id="minefield-mode" v-model="minefieldMode">
            <option value="normal">Normal count-up</option>
            <option value="gotcha">Gotcha</option>
          </select>
        </div>
        <div class="field">
          <label for="minefield-target">Target score</label>
          <input id="minefield-target" v-model.number="minefieldTarget" type="number" min="1" />
        </div>
        <div class="field">
          <label for="minefield-hp-mode">HP basis</label>
          <select id="minefield-hp-mode" v-model="minefieldAutoHP">
            <option :value="true">Per player</option>
            <option :value="false">Total per number</option>
          </select>
        </div>
        <div class="field">
          <label for="minefield-hp">{{ minefieldAutoHP ? 'HP per player' : 'HP per number' }}</label>
          <input id="minefield-hp" v-model.number="minefieldHP" type="number" step="1" />
          <output>{{ minefieldSuggestedHP }} HP per number · zero starts armed</output>
        </div>
        <div class="field">
          <label for="minefield-lifetime">Mine lifetime (explosions)</label>
          <input id="minefield-lifetime" v-model.number="minefieldLifetime" type="number" step="1" />
        </div>
        <div v-if="minefieldMode === 'gotcha'" class="field">
          <label for="minefield-knockback">Gotcha knock-back</label>
          <select id="minefield-knockback" v-model="minefieldKnockback">
            <option value="zero">Back to zero</option>
            <option value="previousTurn">Back to previous turn</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="use-handicaps"><input v-model="minefieldDefusal" type="checkbox" /> Allow double/triple defusal (inner bull included)</label>
        <label class="use-handicaps"><input v-model="minefieldBlastRadius" type="checkbox" /> Blast radius: direct mines reset your score; neighbours are blast zones</label>
        <label v-if="minefieldBlastRadius" class="use-handicaps"><input v-model="minefieldResetNegative" type="checkbox" /> Direct mines also reset negative scores to zero</label>
        <label v-if="minefieldMode === 'gotcha'" class="use-handicaps"><input v-model="minefieldExactFinish" type="checkbox" /> Finish on the exact target (overshooting busts the turn)</label>
      </div>
      <p class="hint">
        Everyone shares the field. Each safe dart removes one HP and scores normally; the arming hit still scores.
        A cleared mine regains its full HP. Multipliers start at 1× and rise 0.5× after an explosion clears the hazard.
        Blast zones clear independently and cost the number times its multiplier, rounded to whole points.
        HP is fixed for each leg; the next leg uses the current player count.
      </p>
    </template>

    <template v-else-if="gameType === 'countup'">
      <div class="field">
        <label for="countup-rounds">Rounds per player</label>
        <input id="countup-rounds" v-model.number="countUpRounds" type="number" min="1" max="100" step="1" :aria-invalid="!countUpRoundsValid" />
        <p v-if="!countUpRoundsValid" class="hint" role="alert">Choose a whole number from 1 to 100.</p>
      </div>
      <p class="hint">Start at zero and add every dart's points. Three darts per turn; highest total after everyone has played all rounds wins. Bulls score 25/50. Ties use player order.</p>
    </template>

    <template v-else-if="gameType === 'aroundtheclock'">
      <div class="grid">
        <div class="field"><label for="clock-mode">Mode</label><select id="clock-mode" v-model="clockMode"><option value="full">Full</option><option value="single">Single</option><option value="outer-single">Outer Single</option><option value="double">Double</option><option value="triple">Triple</option></select></div>
        <div class="field"><label for="clock-order">Order</label><select id="clock-order" v-model="clockOrder"><option value="ascending">1–20</option><option value="descending">20–1</option><option value="random">Random</option></select></div>
        <div class="field"><label for="clock-hits">Hits per target</label><select id="clock-hits" v-model.number="clockHits"><option v-for="n in 3" :key="n" :value="n">{{ n }}</option></select></div>
      </div>
      <div class="field">
        <label class="use-handicaps"><input v-model="clockFinishBull" type="checkbox" /> Finish on bull after all numbers</label>
      </div>
      <p class="hint">Complete the required hits on each target. Multipliers never skip targets. Three darts per turn; first to finish wins. Bull accepts either ring in Full mode, outer bull in single modes, and inner bull in double/triple modes.</p>
    </template>

    <template v-else-if="gameType === 'randomcheckout'">
      <div class="grid">
        <div class="field"><label for="checkout-min">Checkout minimum</label><input id="checkout-min" v-model.number="randomCheckout.checkoutMin" type="number" min="2" max="180" /></div>
        <div class="field"><label for="checkout-max">Checkout maximum</label><input id="checkout-max" v-model.number="randomCheckout.checkoutMax" type="number" min="2" max="180" /></div>
        <div class="field"><label for="checkout-out">Out mode</label><select id="checkout-out" v-model="randomCheckout.outMode"><option value="straight">Straight</option><option value="double">Double</option><option value="master">Master</option></select></div>
        <div class="field"><label for="checkout-rounds">Visits per leg</label><input id="checkout-rounds" v-model.number="randomCheckout.maxRounds" type="number" min="1" max="100" /></div>
      </div>
      <label class="use-handicaps"><input v-model="randomCheckout.continuous" type="checkbox" /> Continuous practice — finish with End game</label>
      <p class="hint">All players receive the same random target each leg. Busts restore the visit. Failed continuous legs move on after takeout; successful checkouts start a new leg. End game compares legs actually checked out; no checkout means no winner.</p>
    </template>

    <template v-else-if="gameType === 'roundtheworld'">
      <div class="field"><label for="world-order">Order</label><select id="world-order" v-model="world.order"><option value="ascending">1–20</option><option value="descending">20–1</option><option value="random">Random</option></select></div>
      <label class="use-handicaps"><input v-model="world.finishBull" type="checkbox" /> Include final bull</label>
      <p class="hint">Three darts per target, then move on even on misses. On-target singles/doubles/trebles score 1/2/3 marks; outer/inner bull score 1/2. Everyone plays all targets; most marks wins.</p>
    </template>

    <template v-else-if="gameType === 'segmenttraining'">
      <div class="grid">
        <div class="field"><label for="segment-mode">Mode</label><select id="segment-mode" v-model="segmentPractice.mode"><option value="single">Single</option><option value="outer-single">Outer Single</option><option value="double">Double</option><option value="triple">Triple</option><option value="random">Random</option></select></div>
        <div v-if="segmentPractice.mode !== 'random'" class="field"><label for="segment-number">Number</label><select id="segment-number" v-model.number="segmentPractice.segment"><option v-for="n in 20" :key="n" :value="n">{{ n }}</option></select></div>
        <div class="field"><label for="segment-end">Ends after</label><select id="segment-end" v-model="segmentPractice.endsAfter"><option value="hits">Hits</option><option value="darts">Darts</option></select></div>
        <div class="field"><label for="segment-count">{{ segmentPractice.endsAfter === 'hits' ? 'Hit count' : 'Dart count' }}</label><input id="segment-count" v-model.number="segmentPractice.count" type="number" min="1" max="1000" /></div>
      </div>
      <p class="hint">Hit the exact zone. Random draws a new target after a hit. Hits mode races to the goal; Darts mode compares hits after each player's dart budget. Single accepts inner or outer singles.</p>
    </template>

    <template v-else-if="gameType === 'bobs27'">
      <label class="use-handicaps"><input v-model="bob.allowNegative" type="checkbox" /> Allow negative score</label>
      <label class="use-handicaps"><input v-model="bob.finishBull" type="checkbox" /> Include final inner bull</label>
      <p class="hint">Solo only. Start at 27; take three darts at each double. Each hit adds that double's value. A visit without a hit subtracts it once. Normal mode ends without a win at zero or below.</p>
    </template>

    <template v-else-if="gameType === '121'">
      <div class="grid">
        <div class="field"><label for="climb-rounds">Attempts per player</label><input id="climb-rounds" v-model.number="climb.maxRounds" type="number" min="1" max="100" /></div>
        <div class="field"><label for="climb-darts">Dart mode</label><select id="climb-darts" v-model.number="climb.dartMode"><option :value="9">9 darts</option><option :value="6">6 darts</option></select></div>
        <div class="field"><label for="climb-step">Step</label><select id="climb-step" v-model.number="climb.step"><option v-for="n in [1,3,5]" :key="n" :value="n">{{ n }}</option></select></div>
        <div class="field"><label for="climb-fail">On fail</label><select id="climb-fail" v-model="climb.onFail"><option value="soft">Soft — drop one</option><option value="hard">Hard reset — 121</option><option value="safehouse">Safehouse</option></select></div>
        <div v-if="climb.onFail === 'safehouse'" class="field"><label for="climb-bank">Safehouse every</label><select id="climb-bank" v-model.number="climb.safehouseEvery"><option v-for="n in [1,2,3,5]" :key="n" :value="n">{{ n }} checkout(s)</option></select></div>
      </div>
      <p class="hint">Start at 121 and double out within each attempt. Success raises the target; exhausting the attempt lowers it by the chosen rule. A bust consumes a visit, restoring only that visit. Checking out 170 wins immediately. At the attempt limit, highest final level wins only if someone is above 121.</p>
    </template>

    <template v-else-if="gameType === 'conquest'">
      <div class="grid">
        <div class="field">
          <label for="conquest-defeat">On home capture</label>
          <select id="conquest-defeat" v-model="conquestDefeat">
            <option value="elimination">Eliminate — take their land; players are out</option>
            <option value="conversion">Convert — take their land; players join your faction</option>
          </select>
        </div>
        <div class="field">
          <label for="conquest-board">Territories</label>
          <select id="conquest-board" v-model="conquestSplit">
            <option :value="false">20 — one per number</option>
            <option :value="true">40 — inner and outer halves</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="use-handicaps"><input v-model="conquestMultipliers" type="checkbox" /> Doubles count 2 marks; trebles count 3</label>
        <label class="use-handicaps"><input v-model="conquestFortified" type="checkbox" /> Fortified homes: 9 permanent marks, no healing or comeback</label>
        <label class="use-handicaps"><input v-model="conquestComeback" type="checkbox" :disabled="conquestFortified" /> Comeback foothold: reclaim your original home without adjacency</label>
      </div>
      <p class="hint">Capture adjacent territory with 3 marks. Enemy hits interrupt ordinary attacks from anywhere.
        Last independent faction wins. The uniquely last leader can hit inner bull to arm an instant enemy-base capture. In the split board, doubles belong to the outer half and trebles to the inner half.
        Fortified home damage persists; taking the attacker's neighbouring territory stops further damage.</p>
      <p class="hint" :role="conquestRosterValid ? undefined : 'alert'">Select 2, 4, 5, 10 or 20 players for equally spaced outer homes. Late joins are unavailable.</p>
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
            <span class="who"><PlayerAvatar :player-id="id" />{{ store.profiles.find((p) => p.id === id)?.name }}</span>
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

    <p v-if="trainingError" class="error" role="alert">{{ trainingError }}</p>
    <div v-if="gameType !== 'golf' && !(gameType === 'randomcheckout' && randomCheckout.continuous)" class="grid">
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
  margin-left: auto; background: none; border: 1px solid var(--ui-border); color: var(--ui-secondary);
  border-radius: 999px; padding: 0.3rem 0.85rem; cursor: pointer; font: inherit; font-size: 0.8rem;
}
.head .ghost:hover { border-color: var(--ui-accent); color: #fff; }
.field-head { display: flex; align-items: center; gap: 0.75rem; }
.player-heading { flex-wrap: wrap; }
.player-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-left: auto; }
.player-actions .manual-btn { margin-left: 0; }
.player-order { font-variant-numeric: tabular-nums; opacity: 0.75; }
.manual-btn {
  margin-left: auto; background: none; border: 1px solid var(--ui-border); color: var(--ui-secondary);
  border-radius: 999px; padding: 0.25rem 0.75rem; cursor: pointer; font: inherit; font-size: 0.78rem;
}
.manual-btn:hover { border-color: var(--ui-accent); color: #fff; }
.golf-row { grid-template-columns: 7rem 5rem 1fr; }
.field { display: flex; flex-direction: column; gap: 0.35rem; }
label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ui-muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.75rem; }
.hint { margin: 0; font-size: 0.8rem; color: var(--ui-muted); }
.tabs, .chips { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.game-categories { display: flex; flex-wrap: wrap; gap: 0.25rem; border-bottom: 1px solid var(--ui-border); margin-bottom: 0.5rem; }
.game-categories button { flex: 1; padding: 0.65rem 0.5rem; background: none; border: 0; border-bottom: 3px solid transparent; color: var(--ui-muted); font: inherit; font-weight: 650; cursor: pointer; }
.game-categories button.on { color: var(--ui-accent); border-bottom-color: var(--ui-accent); }
.game-categories button:hover { color: var(--ui-text); }
.game-categories button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; border-radius: 4px; }
.player-search { width: 100%; box-sizing: border-box; }
.selected-chips { list-style: none; margin: 0; padding: 0 0 0.5rem; border-bottom: 1px solid var(--ui-border); }
.selected-player { display: flex; align-items: center; gap: 0.35rem; }
.selected-player.dragging { outline: 2px solid var(--accent); box-shadow: 0 4px 14px #0005; }
.drag-handle, .remove-player { background: none; border: 0; color: inherit; padding: 0.2rem; font: inherit; line-height: 1; }
.drag-handle { cursor: grab; touch-action: none; font-size: 1.4rem; user-select: none; }
.drag-handle:active { cursor: grabbing; }
.remove-player { cursor: pointer; font-size: 1.2rem; }
.drag-handle:focus-visible, .remove-player:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; border-radius: 3px; }
.chip.selected-player { cursor: default; }
.chips.scroll {
  max-height: 14rem; overflow-y: auto; align-content: flex-start;
  padding-top: 0.15rem;
}
.chips.scroll .hint { flex-basis: 100%; }
.tabs button, .chip {
  background: var(--ui-surface); border: 1px solid var(--ui-border); color: var(--ui-secondary);
  border-radius: 999px; padding: 0.4rem 0.9rem; cursor: pointer;
}
.tabs button.on { background: #2b3240; border-color: var(--ui-accent); color: #fff; }
.chip.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, var(--ui-surface)); color: #fff; }
select, input {
  background: var(--ui-surface); border: 1px solid var(--ui-border); color: var(--ui-text);
  border-radius: 6px; padding: 0.45rem 0.6rem; font: inherit;
}
.handicaps { border: 1px solid var(--ui-border); border-radius: 8px; padding: 0.75rem; }
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
  background: var(--ui-accent); border: none; color: #fff; font-weight: 600;
  border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; font-size: 1rem;
}
.primary:disabled { opacity: 0.45; cursor: not-allowed; }
.error { color: var(--ui-danger); margin: 0; font-size: 0.85rem; }

.setup { max-width: 1100px; margin-inline: auto; gap: 1.25rem; }
.head { align-items: center; }.head .page-heading { flex: 1; border: 0; }.head .ghost { margin-left: 0; }
.setup > .field, .setup > .grid, .setup > .handicaps { padding: 1.1rem; background: linear-gradient(135deg, #12304490, #0b1e2d); border: 1px solid var(--ui-border); border-radius: 16px; box-shadow: var(--ui-shadow); }
.field { gap: 0.65rem; }label { color: var(--ui-secondary); font-size: 0.72rem; font-weight: 650; }.field-head { flex-wrap: wrap; }
.tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 0.55rem; }
.tabs button { border-radius: 12px; padding: 1.1rem 0.75rem; background: var(--ui-surface-deep); font-size: 1rem; font-weight: 650; }
.tabs button:hover { border-color: #4c748b; background: var(--ui-surface-raised); }.tabs button.on { background: linear-gradient(135deg, #176b8c, #123c55); color: #e2f8ff; border-color: var(--ui-accent); box-shadow: inset 0 -3px var(--ui-accent); }
select, input { border-radius: 9px; background: var(--ui-surface-deep); padding: 0.65rem 0.75rem; min-width: 0; }input[type=checkbox] { flex: none; }
.chip { border-radius: 9px; padding: 0.6rem 0.85rem; }.chip:hover { border-color: var(--accent); }.selected-chips { border-bottom: 0; padding: 0.5rem 0 0; }
.primary { background: linear-gradient(110deg, #71dcff, #40b9ef); color: #062337; border-radius: 12px; padding: 1rem; font-weight: 750; box-shadow: 0 6px 24px #129dcc20; }
.primary:hover:not(:disabled) { box-shadow: 0 6px 28px #129dcc40; }
.handicap-row { grid-template-columns: minmax(6rem, 1fr) repeat(3, minmax(0, 1fr)); }.handicap-row.golf-row { grid-template-columns: minmax(6rem, 1fr) 5rem minmax(0, 2fr); }
@media (max-width: 580px) { .tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }.tabs button { font-size: 0.8rem; padding: 0.85rem 0.2rem; }.head .page-heading { flex-basis: 100%; }.handicap-row, .handicap-row.golf-row { grid-template-columns: 1fr 1fr; }.head .ghost { margin-bottom: 0.4rem; }.manual-btn { margin-left: 0; } }

</style>
