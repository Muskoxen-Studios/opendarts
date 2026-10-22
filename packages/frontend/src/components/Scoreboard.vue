<script setup lang="ts">
import { computed } from 'vue';
import {
  gotcha,
  heartFill,
  isOut,
  killer,
  ordinal,
  placeOf,
  type View,
} from '../gameDetail.ts';

const props = defineProps<{ view: View }>();

const isCricket = computed(() => props.view.gameType === 'cricket');
const isGolf = computed(() => props.view.gameType === 'golf');
const isShanghai = computed(() => props.view.gameType === 'shanghai');
const isKiller = computed(() => props.view.gameType === 'killer');
const isGotcha = computed(() => props.view.gameType === 'gotcha');
const isEvenOdd = computed(() => props.view.gameType === 'evenodd');

/**
 * Cricket combines everyone in its marks table. Other games use the player
 * strip and a detailed card for whoever is throwing.
 */
const activePlayer = computed<View['players'][number] | null>(
  () => props.view.players.find((p) => p.isActive) ?? null,
);

const cricketTargets = computed<number[]>(() => {
  const first = props.view.players[0];
  return (first?.detail.targets as number[] | undefined) ?? [20, 19, 18, 17, 16, 15, 25];
});

function marks(player: View['players'][number], target: number): number {
  const m = player.detail.marks as Record<number, number> | undefined;
  return m?.[target] ?? 0;
}

function fmt(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined ? '–' : n.toFixed(digits);
}

interface GolfHole {
  hole: number;
  par: number;
  strokes: number;
  points: number;
  holed: boolean;
}

function golf(player: View['players'][number]) {
  const d = player.detail;
  return {
    hole: (d.hole as number | null) ?? null,
    holes: (d.holes as number | undefined) ?? 18,
    strokes: (d.strokes as number | undefined) ?? 0,
    par: (d.par as number | null) ?? null,
    handicap: (d.handicap as number | undefined) ?? 0,
    done: (d.done as boolean | undefined) ?? false,
    results: ((d.results as GolfHole[] | undefined) ?? []) as GolfHole[],
  };
}

/** Colour a played hole by how it went, the way a golf card is read. */
function holeClass(points: number): string {
  if (points >= 4) return 'great';
  if (points === 3) return 'good';
  if (points === 2) return 'par';
  if (points === 1) return 'over';
  return 'blank';
}

function evenOdd(player: View['players'][number]) {
  const d = player.detail;
  return {
    targetScore: (d.targetScore as number | undefined) ?? 100,
  };
}

function shanghai(player: View['players'][number]) {
  const d = player.detail;
  return {
    round: (d.round as number | undefined) ?? 1,
    startRound: (d.startRound as number | undefined) ?? 1,
    endRound: (d.endRound as number | undefined) ?? 7,
    results: ((d.results as number[] | undefined) ?? []) as number[],
  };
}

/**
 * The big number on the active player's card. Killer's lives run in thirds, so
 * they are written as a fraction rather than a recurring decimal -- and it
 * matches the partly-eaten heart drawn underneath.
 */
function scoreText(player: View['players'][number]): string {
  if (!isKiller.value) return String(player.score);
  const thirds = killer(player).livesThirds;
  const whole = Math.floor(thirds / 3);
  const part = ['', '\u2153', '\u2154'][thirds % 3]!;
  if (part === '') return String(whole);
  return whole === 0 ? part : `${whole}${part}`;
}
</script>

<template>
  <div class="scoreboard">
    <header class="meta">
      <span class="game">{{ view.gameType.toUpperCase() }}</span>
      <span>Leg {{ view.leg }}</span>
      <span v-if="view.set > 1">Set {{ view.set }}</span>
      <span v-if="view.roundLimit">Round {{ view.round }}/{{ view.roundLimit }}</span>
      <span v-if="view.status === 'finished'" class="done">Finished</span>
    </header>

    <!--
      Keep Cricket's points, player stats and marks together, so the table
      replaces both the player strip and the active player's score card.
    -->
    <div v-if="isCricket" class="cricket-board-wrap">
      <table class="cricket-board">
        <caption class="sr-only">Cricket player scores and target marks</caption>
        <colgroup><col class="player-column" /><col v-for="t in cricketTargets" :key="t" /></colgroup>
        <thead>
          <tr>
            <th class="who" scope="col">Player / points</th>
            <th v-for="t in cricketTargets" :key="t" scope="col">{{ t === 25 ? 'Bull' : t }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in view.players" :key="p.playerId" :class="{ active: p.isActive, out: placeOf(p) !== null, winner: view.winnerId === p.playerId }"
            :style="{ '--accent': p.color }">
            <th class="who" scope="row">
              <div class="cricket-player">
                <div class="cricket-identity">
                  <span class="cricket-player-name">{{ p.name }}</span>
                  <span class="cricket-turn-label" :class="{ visible: p.isActive }" :aria-hidden="!p.isActive">At the oche</span>
                  <span v-if="placeOf(p)" class="mini-place">{{ ordinal(placeOf(p)!) }}</span>
                </div>
                <strong class="cricket-points" :aria-label="`${p.score} points`">{{ p.score }}</strong>
                <div class="cricket-player-stats">
                  <span>{{ fmt(p.stats.mpr, 2) }} MPR</span>
                  <span>{{ p.stats.dartsThrown }} darts</span>
                  <span :title="`${p.setsWon} sets won, ${p.legsWon} legs won`">Sets/legs {{ p.setsWon }}–{{ p.legsWon }}</span>
                </div>
              </div>
            </th>
            <td v-for="t in cricketTargets" :key="t" :class="{ closed: marks(p, t) >= 3 }" :aria-label="`${t === 25 ? 'Bull' : t}: ${Math.min(marks(p, t), 3)} marks`">
              <svg class="cricket-mark" :class="{ empty: marks(p, t) === 0 }" viewBox="0 0 40 40" aria-hidden="true">
                <circle v-if="marks(p, t) === 0" cx="20" cy="20" r="1.5" fill="currentColor" stroke="none" />
                <path v-if="marks(p, t) >= 1" d="M12 28 28 12" />
                <path v-if="marks(p, t) >= 2" d="M12 12 28 28" />
                <circle v-if="marks(p, t) >= 3" cx="20" cy="20" r="17" />
              </svg>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="players">
      <article v-for="p in activePlayer ? [activePlayer] : []" :key="p!.playerId" class="player"
        :class="{ active: p!.isActive, winner: view.winnerId === p!.playerId, out: isOut(p!, view.gameType) }"
        :style="{ '--accent': p!.color }">
        <div class="row">
          <span class="name">{{ p!.name }}</span>
          <span v-if="placeOf(p!)" class="place" :class="`p${placeOf(p!)}`">
            {{ ordinal(placeOf(p!)!) }}
          </span>
          <span class="legs">{{ p!.setsWon }}&ndash;{{ p!.legsWon }}</span>
        </div>

        <div class="score">{{ scoreText(p!) }}</div>

        <div v-if="isGolf" class="golf">
          <div class="golf-line">
            <span v-if="golf(p!).done" class="done-tag">round complete</span>
            <template v-else>
              <span class="hole">Hole {{ golf(p!).hole }}/{{ golf(p!).holes }}</span>
              <span class="par">par {{ golf(p!).par }}</span>
              <span class="strokes">{{ golf(p!).strokes }} thrown</span>
            </template>
            <span class="hcp">hcp {{ golf(p!).handicap }}</span>
          </div>
          <!-- The card so far: one square a hole, coloured by how it went. -->
          <div v-if="golf(p!).results.length" class="card">
            <span v-for="h in golf(p!).results" :key="h.hole" class="cell" :class="holeClass(h.points)"
              :title="`Hole ${h.hole}: ${h.holed ? h.strokes : 'not holed'} of par ${h.par} — ${h.points} pts`">{{
                h.points
              }}</span>
          </div>
        </div>

        <div v-if="isShanghai" class="shanghai">
          <div class="shanghai-line">
            <span class="round">Round {{ shanghai(p!).round <= shanghai(p!).endRound ? shanghai(p!).round :
              shanghai(p!).endRound }}/{{ shanghai(p!).endRound }}</span>
          </div>
          <div v-if="shanghai(p!).results.length" class="card">
            <span v-for="(r, i) in shanghai(p!).results" :key="i" class="cell" :class="r > 0 ? 'good' : 'blank'">{{ r
              }}</span>
          </div>
        </div>

        <div v-if="isEvenOdd" class="shanghai">
          <div class="shanghai-line">
            <span class="round">{{ p!.score }} / {{ evenOdd(p!).targetScore }}</span>
          </div>
        </div>

        <!--
          Gotcha counts up to a fixed target, and busting knocks you back --
          how far is left and what a bust costs are the two things worth
          knowing while you decide what to aim at.
        -->
        <div v-if="isGotcha" class="killer">
          <div class="killer-line">
            <span class="number">{{ gotcha(p!).remaining }} to go</span>
            <span class="killer-progress">target {{ gotcha(p!).target }}</span>
            <span class="killer-tag">
              {{ gotcha(p!).knockback === 'zero' ? 'bust → zero' : 'bust → turn start' }}
            </span>
          </div>
        </div>

        <div v-if="isKiller" class="killer">
          <div class="killer-line">
            <span v-if="killer(p!).eliminated" class="done-tag out">eliminated</span>
            <template v-else>
              <span v-if="killer(p!).phase === 'assign'" class="waiting">finding a number&hellip;</span>
              <template v-else>
                <span class="number">No. {{ killer(p!).number }}</span>
                <span v-if="killer(p!).isKiller" class="killer-tag">killer</span>
                <!-- Until you are a killer, how close you are is the only thing worth knowing. -->
                <span v-else class="killer-progress">{{ killer(p!).ownHits }}/{{ killer(p!).hitsToKill }} hits</span>
              </template>
            </template>
          </div>
          <div class="lives">
            <span v-for="i in killer(p!).startingLives" :key="i" class="life"
              :style="{ '--fill': heartFill(p!, i) }" />
          </div>
        </div>

        <div v-if="p!.checkout" class="checkout">
          <span v-for="(d, i) in p!.checkout" :key="i" class="dart">{{ d }}</span>
        </div>

        <footer class="stats">
          <span v-if="p!.stats.average3 !== null">avg {{ fmt(p!.stats.average3) }}</span>
          <span v-if="p!.stats.mpr !== null && p!.stats.mpr !== undefined">mpr {{ fmt(p!.stats.mpr, 2) }}</span>
          <span>{{ p!.stats.dartsThrown }} darts</span>
        </footer>
      </article>
    </div>

    <div class="turn">
      <span v-for="(t, i) in view.turn.throws" :key="i" class="slot thrown">
        {{ t.label }}
      </span>

      <!--
        Empty slots show the checkout route, and only when one is actually on.
        Muted, so they read as a suggestion rather than a score.
      -->
      <span v-for="i in view.turn.dartsRemaining" :key="`empty-${i}`" class="slot" :class="[
        view.turn.hints[i - 1] ? 'hint' : 'empty',
        /* The dart to throw right now is brighter than the ones behind it,
           and matches the segment lit up on the board. */
        view.turn.hints[i - 1] && i === 1 ? 'next' : '',
      ]">
        {{ view.turn.hints[i - 1] ?? '—' }}
      </span>
    </div>

    <div class="turn-total">
      <span class="label">This turn</span>
      <span class="value">{{ view.turn.total }}</span>
    </div>
  </div>
</template>

<style scoped>
.scoreboard {
  /* The heart silhouette the life pips are masked with. */
  --heart:
    url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' fill='black'/%3E%3C/svg%3E");
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.meta {
  display: flex;
  gap: 1rem;
  align-items: center;
  font-size: 0.8rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-muted);
}

.game {
  color: var(--ui-text);
  font-weight: 700;
}

.done {
  color: var(--ui-success);
  font-weight: 700;
}

.players {
  display: grid;
  gap: 0.75rem;
}

.player {
  border: 1px solid var(--ui-border);
  border-left: 4px solid var(--accent);
  border-radius: 10px;
  padding: 0.75rem 1rem;
  background: var(--ui-surface);
  transition: background 120ms ease, border-color 120ms ease;
}

.player.active {
  background: var(--ui-surface-raised);
  border-color: var(--accent);
}

.player.winner {
  box-shadow: 0 0 0 2px var(--ui-success) inset;
}

/* Checked out, but the leg is still running for everyone else. */
.player.out {
  opacity: 0.62;
}

.place {
  margin-left: 0.6rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  background: var(--ui-border);
  color: var(--ui-secondary);
}

.place.p1 {
  background: #4a3c14;
  color: #e0b84a;
}

.place.p2 {
  background: #2f3339;
  color: #c4ccd6;
}

.place.p3 {
  background: #3a2a1c;
  color: #c8926a;
}

.row {
  display: flex;
  align-items: baseline;
}

.row .legs {
  margin-left: auto;
}

.name {
  font-weight: 600;
  font-size: 1.05rem;
}

.legs {
  color: var(--ui-muted);
  font-variant-numeric: tabular-nums;
}

.score {
  font-size: 3rem;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

/* Cricket's table is the complete roster and scoreboard, including points. */
.cricket-board-wrap { overflow: hidden; }
.cricket-board { width: 100%; table-layout: fixed; border-collapse: collapse; }
.cricket-board .player-column { width: 30%; }
.cricket-board th, .cricket-board td { padding: 0.7rem 0.35rem; text-align: center; font-variant-numeric: tabular-nums; }
.cricket-board thead th { font-size: clamp(0.75rem, 2cqw, 1.15rem); color: var(--ui-muted); font-weight: 650; padding-block: 0.85rem; }
.cricket-board th.who { text-align: left; white-space: normal; overflow-wrap: anywhere; }
.cricket-board thead th.who { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
.cricket-board tbody tr { border-top: 1px solid var(--ui-border); }
.cricket-board tbody th.who { border-left: 4px solid var(--accent); padding: 0.8rem; }
.cricket-board tbody tr.active { background: color-mix(in srgb, var(--accent) 12%, var(--ui-surface-deep)); }
.cricket-board tbody tr.out { opacity: 0.62; }
.cricket-board tbody tr.winner { opacity: 1; }
.cricket-player { display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem 0.6rem; }
.cricket-identity { flex: 1 1 5rem; min-width: 0; }
.cricket-player-name { display: block; color: var(--ui-text); font-weight: 650; font-size: clamp(0.85rem, 2cqw, 1.2rem); line-height: 1.25; }
.cricket-turn-label { display: block; visibility: hidden; color: var(--accent); font-size: 0.65rem; line-height: 1.5; margin-top: 0.2rem; }
.cricket-turn-label.visible { visibility: visible; }
.mini-place { color: #ffda80; font-size: 0.75rem; font-weight: 750; }
.cricket-points { color: var(--ui-accent); font-size: clamp(1.5rem, 4cqw, 2.8rem); line-height: 1.1; letter-spacing: -0.04em; }
.cricket-player-stats { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 0.15rem 0.6rem; color: var(--ui-muted); font-size: 0.65rem; font-weight: 400; line-height: 1.5; }
.cricket-mark { display: block; width: 100%; max-width: 3.8rem; height: auto; margin-inline: auto; color: var(--ui-secondary); fill: none; stroke: currentColor; stroke-width: 2.8; stroke-linecap: round; }
.cricket-mark.empty { color: #48667b; }
.cricket-board td.closed { background: #173c32; }
.cricket-board td.closed .cricket-mark { color: #79e5b3; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@container (max-width: 500px) {
  .cricket-board .player-column { width: 34%; }
  .cricket-board thead th { font-size: 0.7rem; }
  .cricket-board tbody th.who { padding: 0.5rem; }
  .cricket-board th, .cricket-board td { padding-inline: 0.15rem; }
  .cricket-player { gap: 0.2rem; }
  .cricket-player-stats { font-size: 0.6rem; }
}

.golf {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.golf-line {
  display: flex;
  gap: 0.7rem;
  font-size: 0.78rem;
  color: var(--ui-muted);
  flex-wrap: wrap;
}

.golf-line .hole {
  color: var(--ui-secondary);
  font-weight: 600;
}

.golf-line .hcp {
  margin-left: auto;
}

.done-tag {
  color: var(--ui-success);
  font-weight: 600;
}

.card {
  display: flex;
  gap: 0.15rem;
  flex-wrap: wrap;
}

.card .cell {
  min-width: 1.15rem;
  text-align: center;
  border-radius: 3px;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.05rem 0.1rem;
  font-variant-numeric: tabular-nums;
}

.card .great {
  background: #1d3b26;
  color: #6fd68c;
}

.card .good {
  background: #1b3040;
  color: #6fb2e0;
}

.card .par {
  background: #23272f;
  color: var(--ui-secondary);
}

.card .over {
  background: #33291a;
  color: #d2a860;
}

.card .blank {
  background: #2a1c1e;
  color: #a4666a;
}

.shanghai {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.shanghai-line {
  font-size: 0.78rem;
  color: var(--ui-secondary);
  font-weight: 600;
}

.killer {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.killer-line {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.78rem;
}

.killer-line .waiting {
  color: var(--ui-muted);
}

.killer-line .number {
  color: var(--ui-secondary);
  font-weight: 600;
}

.killer-line .killer-tag {
  background: #3a2213;
  color: #e0a458;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
}

.killer-line .done-tag.out {
  color: #d8453f;
}

.lives {
  display: flex;
  gap: 0.2rem;
  font-size: 1rem;
}

/*
  A heart is a box masked into the heart shape and filled left-to-right by a
  hard-stop gradient, so a third of a life lost reads as a third of a heart
  eaten. Drawn rather than typed: the text glyph renders as a colour emoji on
  some systems, where neither `color` nor a clipped overlay does anything.
*/
.life {
  display: inline-block;
  width: 1em;
  height: 1em;
  background: linear-gradient(90deg, #d8453f var(--fill, 100%), #333a45 var(--fill, 100%));
  -webkit-mask: var(--heart) center / contain no-repeat;
  mask: var(--heart) center / contain no-repeat;
}

.killer-progress {
  font-size: 0.85rem;
  color: var(--ui-muted);
}

.checkout {
  display: flex;
  gap: 0.35rem;
  margin-top: 0.4rem;
}

.dart {
  background: var(--ui-border);
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  font-size: 0.8rem;
  color: var(--ui-secondary);
}

.stats {
  display: flex;
  gap: 0.9rem;
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--ui-muted);
  font-variant-numeric: tabular-nums;
}

.turn {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.6rem;
}

.slot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 5.5rem;
  padding: 0.4rem 0.3rem;
  border-radius: 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface-raised);
  font-size: 4rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  /* "BULL" is much wider than "T20"; shrink rather than overflow the box. */
  overflow: hidden;
  text-overflow: clip;
  container-type: inline-size;
}

.slot.thrown {
  color: var(--ui-text);
}

.slot.empty {
  color: #333a45;
  font-size: 2.5rem;
}

/* The checkout route is deliberately low-contrast: advice, not a score. */
.slot.hint {
  background: var(--ui-surface);
  border-style: dashed;
  font-weight: 600;
  color: #5d7fa8;
}

/* Except the next dart, which is the one being aimed at this second. */
.slot.hint.next {
  color: #ffd166;
  border-color: #6a5a2c;
  border-style: solid;
  background: #191a17;
}

/* Long labels would otherwise spill out of a fixed 4rem box. */
@container (max-width: 7rem) {
  .slot {
    font-size: 3rem;
  }
}

.turn-total {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.turn-total .label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ui-muted);
}

.turn-total .value {
  margin-left: auto;
  font-size: 2rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.scoreboard { container-type: inline-size; padding: clamp(1rem, 2vw, 1.6rem); border-radius: 18px; border: 1px solid var(--ui-border); background: linear-gradient(145deg, #123448, #0c1d2c 65%); box-shadow: var(--ui-shadow); }
.meta { flex-wrap: wrap; gap: 0.75rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--ui-border-soft); }
.game { padding: 0.35rem 0.65rem; background: #56cfff18; border: 1px solid #56cfff35; border-radius: 8px; color: var(--ui-accent); }
.player { border-radius: 16px; padding: 1.2rem; position: relative; overflow: hidden; }
.player.active { background: radial-gradient(ellipse at 100% 0%, color-mix(in srgb, var(--accent) 15%, transparent), transparent 65%), var(--ui-surface-deep); border-color: color-mix(in srgb, var(--accent) 65%, var(--ui-border)); }
.name { font-size: 1.2rem; }.row { gap: 0.5rem; flex-wrap: wrap; }
.score { font-size: clamp(4.5rem, 9vw, 8rem); letter-spacing: -0.055em; padding: 0.35rem 0; text-shadow: 0 4px 24px #0003; }
.golf-line, .shanghai-line, .killer-line { font-size: 0.9rem; gap: 0.6rem; line-height: 1.5; flex-wrap: wrap; }
.golf-line .hole { color: var(--ui-accent); }.golf-line .hcp { background: #ffffff0a; padding: 0 0.5rem; border-radius: 5px; }
.card { gap: 0.3rem; margin-top: 0.4rem; }.card .cell { min-width: 1.9rem; padding: 0.4rem 0.3rem; border-radius: 6px; font-size: 0.85rem; }
.stats { flex-wrap: wrap; gap: 0.75rem; padding-top: 0.8rem; border-top: 1px solid var(--ui-border-soft); }
.checkout { flex-wrap: wrap; gap: 0.4rem; }.dart { color: var(--ui-accent); border: 1px solid #56cfff40; background: #56cfff12; padding: 0.35rem 0.6rem; border-radius: 7px; font-weight: 700; }
.slot { background: linear-gradient(145deg, #1d4057, #102a3c); border-color: #345b72; border-radius: 14px; min-height: 6.5rem; box-shadow: inset 0 1px #ffffff08; }
.slot.thrown { border-bottom: 3px solid var(--ui-accent); }.slot.empty { color: #56748b; }.slot.hint { color: #86a6bf; background: #0d2333; }.slot.hint.next { background: #332b18; color: #ffdc80; border-color: #977b38; }
.turn-total { border: 1px solid var(--ui-border-soft); border-radius: 12px; background: var(--ui-surface-deep); padding: 0.65rem 1rem; }.turn-total .value { color: var(--ui-accent); }
.cricket-board-wrap { border: 1px solid var(--ui-border); border-radius: 12px; padding: 0.4rem; background: var(--ui-surface-deep); }
@media (max-width: 580px) { .player { padding: 0.85rem; }.meta { letter-spacing: 0.03em; font-size: 0.7rem; }.slot { min-height: 5rem; font-size: 2.6rem; } }

</style>
