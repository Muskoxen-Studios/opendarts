<script setup lang="ts">
import { computed, type DeepReadonly } from 'vue';
import type { MatchView } from '@darts/schema';

// The store is exposed through Vue's readonly() wrapper so components cannot
// mutate match state directly -- it is server-authoritative. That makes the
// incoming view deeply readonly, which the prop type has to reflect.
type View = DeepReadonly<MatchView>;

const props = defineProps<{ view: View }>();

const isCricket = computed(() => props.view.gameType === 'cricket');
const isGolf = computed(() => props.view.gameType === 'golf');

const cricketTargets = computed<number[]>(() => {
  const first = props.view.players[0];
  return (first?.detail.targets as number[] | undefined) ?? [20, 19, 18, 17, 16, 15, 25];
});

function marks(player: View['players'][number], target: number): number {
  const m = player.detail.marks as Record<number, number> | undefined;
  return m?.[target] ?? 0;
}

/** Cricket marks render as the conventional slash, cross, circled cross. */
function markGlyph(n: number): string {
  return ['', '/', '✕', '⊗'][Math.min(n, 3)] ?? '';
}

function fmt(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined ? '–' : n.toFixed(digits);
}

/** Finishing place in a leg played to places, or null while still in. */
function placeOf(player: View['players'][number]): number | null {
  return (player.detail.place as number | null) ?? null;
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

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
function ordinal(place: number): string {
  return ORDINALS[place - 1] ?? `${place}th`;
}
</script>

<template>
  <div class="scoreboard">
    <header class="meta">
      <span class="game">{{ view.gameType.toUpperCase() }}</span>
      <span>Leg {{ view.leg }}</span>
      <span v-if="view.set > 1">Set {{ view.set }}</span>
      <span v-if="view.status === 'finished'" class="done">Finished</span>
    </header>

    <div class="players">
      <article
        v-for="p in view.players"
        :key="p.playerId"
        class="player"
        :class="{ active: p.isActive, winner: view.winnerId === p.playerId, out: placeOf(p) !== null }"
        :style="{ '--accent': p.color }"
      >
        <div class="row">
          <span class="name">{{ p.name }}</span>
          <span v-if="placeOf(p)" class="place" :class="`p${placeOf(p)}`">
            {{ ordinal(placeOf(p)!) }}
          </span>
          <span class="legs">{{ p.setsWon }}&ndash;{{ p.legsWon }}</span>
        </div>

        <div class="score">{{ p.score }}</div>

        <div v-if="isCricket" class="marks">
          <span v-for="t in cricketTargets" :key="t" class="mark">
            <em>{{ t === 25 ? 'B' : t }}</em>
            <b>{{ markGlyph(marks(p, t)) }}</b>
          </span>
        </div>

        <div v-if="isGolf" class="golf">
          <div class="golf-line">
            <span v-if="golf(p).done" class="done-tag">round complete</span>
            <template v-else>
              <span class="hole">Hole {{ golf(p).hole }}/{{ golf(p).holes }}</span>
              <span class="par">par {{ golf(p).par }}</span>
              <span class="strokes">{{ golf(p).strokes }} thrown</span>
            </template>
            <span class="hcp">hcp {{ golf(p).handicap }}</span>
          </div>
          <!-- The card so far: one square a hole, coloured by how it went. -->
          <div v-if="golf(p).results.length" class="card">
            <span
              v-for="h in golf(p).results"
              :key="h.hole"
              class="cell"
              :class="holeClass(h.points)"
              :title="`Hole ${h.hole}: ${h.holed ? h.strokes : 'not holed'} of par ${h.par} — ${h.points} pts`"
            >{{ h.points }}</span>
          </div>
        </div>

        <div v-if="p.checkout" class="checkout">
          <span v-for="(d, i) in p.checkout" :key="i" class="dart">{{ d }}</span>
        </div>

        <footer class="stats">
          <span v-if="p.stats.average3 !== null">avg {{ fmt(p.stats.average3) }}</span>
          <span v-if="p.stats.mpr !== null && p.stats.mpr !== undefined">mpr {{ fmt(p.stats.mpr, 2) }}</span>
          <span>{{ p.stats.dartsThrown }} darts</span>
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
      <span
        v-for="i in view.turn.dartsRemaining"
        :key="`empty-${i}`"
        class="slot"
        :class="[
          view.turn.hints[i - 1] ? 'hint' : 'empty',
          /* The dart to throw right now is brighter than the ones behind it,
             and matches the segment lit up on the board. */
          view.turn.hints[i - 1] && i === 1 ? 'next' : '',
        ]"
      >
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
.scoreboard { display: flex; flex-direction: column; gap: 1rem; }
.meta {
  display: flex; gap: 1rem; align-items: center;
  font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: #8b93a1;
}
.game { color: #e8e6e1; font-weight: 700; }
.done { color: #3f9d54; font-weight: 700; }

.players { display: grid; gap: 0.75rem; }
.player {
  border: 1px solid #262b33;
  border-left: 4px solid var(--accent);
  border-radius: 10px;
  padding: 0.75rem 1rem;
  background: #14171c;
  transition: background 120ms ease, border-color 120ms ease;
}
.player.active { background: #1b2029; border-color: var(--accent); }
.player.winner { box-shadow: 0 0 0 2px #3f9d54 inset; }
/* Checked out, but the leg is still running for everyone else. */
.player.out { opacity: 0.62; }

.place {
  margin-left: 0.6rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  background: #262b33;
  color: #b9c0cc;
}
.place.p1 { background: #4a3c14; color: #e0b84a; }
.place.p2 { background: #2f3339; color: #c4ccd6; }
.place.p3 { background: #3a2a1c; color: #c8926a; }

.row { display: flex; align-items: baseline; }
.row .legs { margin-left: auto; }
.name { font-weight: 600; font-size: 1.05rem; }
.legs { color: #8b93a1; font-variant-numeric: tabular-nums; }

.score {
  font-size: 3rem; font-weight: 700; line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.marks { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.35rem; }
.mark { display: flex; flex-direction: column; align-items: center; min-width: 1.6rem; }
.mark em { font-style: normal; font-size: 0.7rem; color: #8b93a1; }
.mark b { font-size: 1.1rem; min-height: 1.3rem; }

.golf { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.35rem; }
.golf-line { display: flex; gap: 0.7rem; font-size: 0.78rem; color: #8b93a1; flex-wrap: wrap; }
.golf-line .hole { color: #cdd3dc; font-weight: 600; }
.golf-line .hcp { margin-left: auto; }
.done-tag { color: #3f9d54; font-weight: 600; }
.card { display: flex; gap: 0.15rem; flex-wrap: wrap; }
.card .cell {
  min-width: 1.15rem; text-align: center; border-radius: 3px;
  font-size: 0.7rem; font-weight: 600; padding: 0.05rem 0.1rem;
  font-variant-numeric: tabular-nums;
}
.card .great { background: #1d3b26; color: #6fd68c; }
.card .good { background: #1b3040; color: #6fb2e0; }
.card .par { background: #23272f; color: #cdd3dc; }
.card .over { background: #33291a; color: #d2a860; }
.card .blank { background: #2a1c1e; color: #a4666a; }

.checkout { display: flex; gap: 0.35rem; margin-top: 0.4rem; }
.dart {
  background: #262b33; border-radius: 4px;
  padding: 0.1rem 0.4rem; font-size: 0.8rem; color: #b9c0cc;
}

.stats {
  display: flex; gap: 0.9rem; margin-top: 0.5rem;
  font-size: 0.78rem; color: #8b93a1; font-variant-numeric: tabular-nums;
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
  border: 1px solid #262b33;
  background: #1b2029;
  font-size: 4rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  /* "BULL" is much wider than "T20"; shrink rather than overflow the box. */
  overflow: hidden;
  text-overflow: clip;
  container-type: inline-size;
}
.slot.thrown { color: #e8e6e1; }
.slot.empty { color: #333a45; font-size: 2.5rem; }
/* The checkout route is deliberately low-contrast: advice, not a score. */
.slot.hint {
  background: #14171c;
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
  .slot { font-size: 3rem; }
}

.turn-total { display: flex; align-items: baseline; gap: 0.6rem; }
.turn-total .label {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b93a1;
}
.turn-total .value { margin-left: auto; font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
</style>
