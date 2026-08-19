<script setup lang="ts">
import { computed, ref } from 'vue';
import Heatmap from './Heatmap.vue';
import ThrowReplay from './ThrowReplay.vue';
import type { MatchReport, PlayerReport } from '../store.ts';

const props = defineProps<{ report: MatchReport; canReplay?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'rematch'): void }>();

/** Whose darts the heatmap shows; null is everyone's. */
const focus = ref<string | null>(null);

const heatmap = computed(
  () => props.report.players.find((p) => p.playerId === focus.value)?.heatmap ?? props.report.heatmap,
);
const heatColor = computed(
  () => props.report.players.find((p) => p.playerId === focus.value)?.color ?? '#ff8a3d',
);

const winner = computed(() => props.report.players.find((p) => p.playerId === props.report.winnerId));

/** Sorted for the standings table: winner first, then by the game's own order. */
const standings = computed(() => {
  const list = [...props.report.players];
  return list.sort((a, b) => {
    if (a.playerId === props.report.winnerId) return -1;
    if (b.playerId === props.report.winnerId) return 1;
    return b.legsWon - a.legsWon || b.score - a.score;
  });
});

const isX01 = computed(() => props.report.gameType === 'x01');
const isGolf = computed(() => props.report.gameType === 'golf');

function fmt(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? '–' : n.toFixed(digits);
}

function duration(ms: number | null): string {
  if (ms === null) return '–';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Colour a hole by how it went, the way a golf card is read. */
function holeClass(hole: { points: number }): string {
  if (hole.points >= 4) return 'great';
  if (hole.points === 3) return 'good';
  if (hole.points === 2) return 'par';
  if (hole.points === 1) return 'over';
  return 'blank';
}

function golfHoles(p: PlayerReport): Array<{ hole: number; par: number; strokes: number; points: number; holed: boolean }> {
  return p.golf?.holes ?? [];
}

const holeCount = computed(() =>
  Math.max(0, ...props.report.players.map((p) => golfHoles(p).length)),
);
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Match overview">
    <section class="sheet">
      <header>
        <div class="headline">
          <h2 v-if="winner">
            <span class="dot" :style="{ background: winner.color }" />
            {{ winner.name }} {{ report.conceded ? 'led when the game was ended' : 'wins' }}
          </h2>
          <h2 v-else>Match ended</h2>
          <p class="meta">
            {{ report.gameType.toUpperCase() }}
            &middot; {{ report.totalDarts }} darts
            &middot; {{ duration(report.durationMs) }}
            <span v-if="report.endedAt">&middot; {{ when(report.endedAt) }}</span>
          </p>
        </div>
        <button class="close" aria-label="Close" @click="emit('close')">&times;</button>
      </header>

      <div class="grid">
        <div class="col">
          <h3>Standings</h3>
          <table class="standings">
            <thead>
              <tr>
                <th>Player</th>
                <th v-if="isGolf">Pts</th>
                <th v-else-if="isX01">Avg</th>
                <th v-else>Score</th>
                <th v-if="isX01">First 9</th>
                <th v-if="isGolf">Hcp</th>
                <th v-if="isGolf">Holed</th>
                <th v-if="isX01">Best</th>
                <th v-if="isX01">180s</th>
                <th>Darts</th>
                <th v-if="report.legsPlayed > 1">Legs</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in standings"
                :key="p.playerId"
                :class="{ won: p.playerId === report.winnerId }"
              >
                <td>
                  <span class="dot" :style="{ background: p.color }" />
                  {{ p.name }}
                </td>
                <td v-if="isGolf">{{ p.golf?.points ?? 0 }}</td>
                <td v-else-if="isX01">{{ fmt(p.average3) }}</td>
                <td v-else>{{ p.score }}</td>
                <td v-if="isX01">{{ fmt(p.first9Average) }}</td>
                <td v-if="isGolf">{{ p.golf?.handicap ?? '–' }}</td>
                <td v-if="isGolf">{{ p.golf?.holed ?? 0 }}</td>
                <td v-if="isX01">{{ p.bestTurn ?? '–' }}</td>
                <td v-if="isX01">{{ p.count180 }}</td>
                <td>{{ p.darts }}</td>
                <td v-if="report.legsPlayed > 1">{{ p.legsWon }}</td>
              </tr>
            </tbody>
          </table>

          <template v-if="isX01">
            <h3>Checkouts</h3>
            <ul v-if="report.players.some((p) => p.checkouts.length)" class="checkouts">
              <li v-for="p in report.players" :key="p.playerId">
                <template v-for="(c, i) in p.checkouts" :key="i">
                  <span class="pill" :style="{ '--accent': p.color }">
                    {{ p.name }} &mdash; {{ c.from }} in {{ c.darts }} darts on {{ c.finisher }}
                  </span>
                </template>
              </li>
            </ul>
            <p v-else class="hint">No checkout this match.</p>
          </template>

          <template v-if="isGolf && holeCount > 0">
            <h3>Card</h3>
            <div class="card-scroll">
              <table class="card">
                <thead>
                  <tr>
                    <th>Hole</th>
                    <th v-for="h in holeCount" :key="h">{{ h }}</th>
                    <th>Pts</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in standings" :key="p.playerId">
                    <th class="who">
                      <span class="dot" :style="{ background: p.color }" />{{ p.name }}
                    </th>
                    <td
                      v-for="(hole, i) in golfHoles(p)"
                      :key="i"
                      :class="holeClass(hole)"
                      :title="`Hole ${hole.hole}: ${hole.strokes} of par ${hole.par}`"
                    >
                      {{ hole.holed ? hole.strokes : '–' }}
                    </td>
                    <td class="pts">{{ p.golf?.points ?? 0 }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="hint">
              Strokes taken on each hole against that player's own par. A dash is
              a hole abandoned one over par, worth nothing.
            </p>
          </template>

          <template v-if="report.winningTurn">
            <h3>{{ report.conceded ? 'Last turn' : 'Winning turn' }}</h3>
            <ThrowReplay
              :darts="report.winningTurn.darts"
              :color="report.winningTurn.color"
            />
          </template>
        </div>

        <div class="col">
          <h3>Where the darts landed</h3>
          <div class="chips">
            <button :class="{ on: focus === null }" @click="focus = null">Everyone</button>
            <button
              v-for="p in report.players"
              :key="p.playerId"
              :class="{ on: focus === p.playerId }"
              :style="{ '--accent': p.color }"
              @click="focus = p.playerId"
            >{{ p.name }}</button>
          </div>
          <Heatmap :heatmap="heatmap" :color="heatColor" />
        </div>
      </div>

      <footer>
        <button v-if="canReplay" class="primary" @click="emit('rematch')">Play again</button>
        <button class="ghost" @click="emit('close')">Close</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; z-index: 30;
  background: rgb(6 8 11 / 78%);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 1.5rem 1rem; overflow: auto;
}
.sheet {
  width: min(1000px, 100%);
  background: #0f1216; border: 1px solid #262b33; border-radius: 14px;
  padding: 1.1rem 1.25rem 1rem;
  display: flex; flex-direction: column; gap: 0.9rem;
  box-shadow: 0 24px 60px rgb(0 0 0 / 55%);
}
header { display: flex; align-items: flex-start; gap: 1rem; }
h2 { margin: 0; font-size: 1.35rem; display: flex; align-items: center; gap: 0.5rem; }
h3 {
  margin: 0.4rem 0 0.35rem; font-size: 0.75rem; color: #8b93a1;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.meta { margin: 0.2rem 0 0; font-size: 0.78rem; color: #8b93a1; }
.close { margin-left: auto; background: none; border: none; color: #6b7280; font-size: 1.6rem; line-height: 1; cursor: pointer; }
.close:hover { color: #e8e6e1; }
.dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; flex: none; margin-right: 0.35rem; }

.grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 1.25rem; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
.col { display: flex; flex-direction: column; min-width: 0; }

table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 0.35rem 0.4rem; font-size: 0.85rem; }
th:first-child, td:first-child { text-align: left; }
thead th { font-size: 0.68rem; color: #8b93a1; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
tbody tr { border-top: 1px solid #1d222a; }
tbody tr.won { color: #fff; font-weight: 600; }

.card-scroll { overflow-x: auto; }
.card td { min-width: 1.7rem; text-align: center; border-radius: 4px; }
.card th.who { white-space: nowrap; }
.card .great { background: #1d3b26; color: #6fd68c; }
.card .good { background: #1b3040; color: #6fb2e0; }
.card .par { background: #23272f; color: #cdd3dc; }
.card .over { background: #33291a; color: #d2a860; }
.card .blank { background: #2a1c1e; color: #a4666a; }
.card .pts { font-weight: 700; }

.checkouts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.pill {
  display: inline-block; border: 1px solid var(--accent); border-radius: 999px;
  padding: 0.15rem 0.6rem; font-size: 0.78rem; margin-right: 0.3rem;
}
.hint { margin: 0.3rem 0 0; font-size: 0.75rem; color: #8b93a1; }

.chips { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.chips button {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 999px; padding: 0.25rem 0.7rem; cursor: pointer; font: inherit; font-size: 0.78rem;
}
.chips button.on { border-color: var(--accent, #4f8ef7); color: #fff; background: #1b2029; }

footer { display: flex; gap: 0.5rem; justify-content: flex-end; }
.primary { background: #4f8ef7; border: none; color: #fff; border-radius: 8px; padding: 0.55rem 1.1rem; cursor: pointer; font-weight: 600; }
.ghost { background: none; border: 1px solid #333b49; color: #cdd3dc; border-radius: 8px; padding: 0.55rem 1.1rem; cursor: pointer; }
</style>
