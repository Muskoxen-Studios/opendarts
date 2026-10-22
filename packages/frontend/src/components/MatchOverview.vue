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
const isCricket = computed(() => props.report.gameType === 'cricket');
const gameName = computed(() => ({ x01: 'X01', golf: 'Golf', cricket: 'Cricket', gotcha: 'Gotcha', killer: 'Killer', shanghai: 'Shanghai' })[props.report.gameType] ?? props.report.gameType);
const featured = computed(() => winner.value ?? standings.value[0]);
const highlights = computed(() => {
  const p = featured.value;
  if (!p) return [];
  if (isGolf.value && p.golf) return [
    { label: 'Stableford points', value: p.golf.points, detail: `${signed(p.golf.points - p.golf.parTarget)} against a target of ${p.golf.parTarget}` },
    { label: 'Birdies or better', value: p.golf.birdiesOrBetter, detail: `${p.golf.holed} holes completed` },
    { label: 'Handicap after round', value: p.golf.handicapAfter, detail: `${signed(p.golf.handicapChange)} change · played off ${p.golf.handicap}` },
  ];
  if (isX01.value) return [
    { label: 'Three-dart average', value: fmt(p.average3), detail: `First nine ${fmt(p.first9Average)}` },
    { label: 'Best visit', value: p.bestTurn ?? '–', detail: `${p.count180} maximums · ${p.count100plus} visits of 100+` },
    { label: 'Highest checkout', value: p.highestCheckout || '–', detail: `${p.checkouts.length} checkouts · ${p.bustedTurns} busts` },
  ];
  return [
    { label: isCricket.value ? 'Marks scored' : 'Points scored', value: p.score, detail: p.name },
    { label: isCricket.value ? 'Marks per round' : 'Best visit', value: isCricket.value ? fmt(p.mpr) : p.bestTurn ?? '–', detail: `${p.darts} darts thrown` },
    { label: 'Legs won', value: p.legsWon, detail: `${props.report.legsPlayed} legs played` },
  ];
});

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

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
    <section class="sheet" :class="{ golf: isGolf }">
      <header>
        <div class="hero-icon" aria-hidden="true">{{ isGolf ? '⚑' : '★' }}</div>
        <div class="headline">
          <p class="eyebrow">{{ gameName }} / {{ report.conceded ? 'Game ended early' : 'Match complete' }}</p>
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

      <div class="highlights" :aria-label="`${featured?.name ?? 'Match'} highlights`">
        <article v-for="h in highlights" :key="h.label" class="highlight">
          <span>{{ h.label }}</span><strong>{{ h.value }}</strong><small>{{ h.detail }}</small>
        </article>
      </div>

      <div class="grid">
        <div class="col">
          <h3>Final standings <span class="section-note">{{ report.players.length }} players</span></h3>
          <div class="player-cards">
            <article v-for="(p, rank) in standings" :key="p.playerId" class="player-card"
              :class="{ won: p.playerId === report.winnerId }" :style="{ '--player': p.color }">
              <div class="player-heading">
                <span class="rank">{{ rank + 1 }}</span>
                <span class="avatar">{{ p.name.slice(0, 1).toUpperCase() }}</span>
                <div class="player-name"><strong>{{ p.name }}</strong><small>{{ p.darts }} darts<span v-if="report.legsPlayed > 1"> · {{ p.legsWon }} legs won</span></small></div>
                <div class="player-score"><b>{{ isGolf ? p.golf?.points : isX01 ? fmt(p.average3) : p.score }}</b><small>{{ isGolf ? 'points' : isX01 ? 'average' : isCricket ? 'marks' : 'points' }}</small></div>
              </div>
              <div v-if="p.golf" class="player-details">
                <div><small>Handicap</small><strong>{{ p.golf.handicap }} <span class="arrow">→</span> {{ p.golf.handicapAfter }}</strong></div>
                <div><small>Change</small><strong class="change" :class="{ improved: p.golf.handicapChange < 0 }">{{ signed(p.golf.handicapChange) }}<span v-if="p.golf.handicapChange === 0" class="unchanged"> unchanged</span></strong></div>
                <div><small>Holed</small><strong>{{ p.golf.holed }} / {{ golfHoles(p).length }}</strong></div>
                <div><small>Birdies+</small><strong>{{ p.golf.birdiesOrBetter }}</strong></div>
              </div>
              <div v-else-if="isX01" class="player-details">
                <div><small>First nine</small><strong>{{ fmt(p.first9Average) }}</strong></div>
                <div><small>Best visit</small><strong>{{ p.bestTurn ?? '–' }}</strong></div>
                <div><small>180s</small><strong>{{ p.count180 }}</strong></div>
                <div><small>Busts</small><strong>{{ p.bustedTurns }}</strong></div>
              </div>
              <div v-else class="player-details">
                <div v-if="isCricket"><small>Marks / round</small><strong>{{ fmt(p.mpr) }}</strong></div>
                <div><small>Best visit</small><strong>{{ p.bestTurn ?? '–' }}</strong></div>
                <div><small>Legs won</small><strong>{{ p.legsWon }}</strong></div>
              </div>
            </article>
          </div>

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
            <h3>Round scorecard <span class="section-note">{{ holeCount }} holes</span></h3>
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
            <div class="legend"><span class="great">Eagle+</span><span class="good">Birdie</span><span class="par">Par</span><span class="over">Over par</span><span class="blank">Abandoned</span></div>
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

        <div class="col map-panel">
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
        <span class="signoff">{{ isGolf ? 'Good darts. See you next round.' : 'Every dart tells a story.' }}</span>
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
  width: min(1280px, 100%);
  --accent: #56cfff;
  background: radial-gradient(ellipse at 80% 0%, #123b59 0%, transparent 55%), #091724;
  border: 1px solid #295270; border-radius: 22px;
  padding: clamp(1rem, 2.5vw, 2rem);
  display: flex; flex-direction: column; gap: 1.3rem;
  box-shadow: 0 24px 60px rgb(0 0 0 / 55%);
}
header { display: flex; align-items: flex-start; gap: 1rem; }
h2 { margin: 0; font-size: clamp(1.4rem, 3vw, 2.4rem); display: flex; align-items: center; gap: 0.5rem; }
h3 {
  margin: 0.4rem 0 0.35rem; font-size: 0.75rem; color: #a2b7c9;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.meta { margin: 0.2rem 0 0; font-size: 0.78rem; color: #a2b7c9; }
.close { margin-left: auto; background: none; border: none; color: #6b7280; font-size: 1.6rem; line-height: 1; cursor: pointer; }
.close:hover { color: #e8e6e1; }
.dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; flex: none; margin-right: 0.35rem; }

.grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 1.25rem; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
.col { display: flex; flex-direction: column; min-width: 0; }

table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 0.35rem 0.4rem; font-size: 0.85rem; }
th:first-child, td:first-child { text-align: left; }
thead th { font-size: 0.68rem; color: #a2b7c9; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
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
.hint { margin: 0.3rem 0 0; font-size: 0.75rem; color: #a2b7c9; }

.chips { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.chips button {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 999px; padding: 0.25rem 0.7rem; cursor: pointer; font: inherit; font-size: 0.78rem;
}
.chips button.on { border-color: var(--accent, #4f8ef7); color: #fff; background: #1b2029; }

footer { display: flex; gap: 0.5rem; justify-content: flex-end; }
.primary { background: var(--accent); border: none; color: #052337; border-radius: 8px; padding: 0.55rem 1.1rem; cursor: pointer; font-weight: 600; }
.ghost { background: none; border: 1px solid #333b49; color: #cdd3dc; border-radius: 8px; padding: 0.55rem 1.1rem; cursor: pointer; }

.sheet.golf { --accent: #69e9c0; background: radial-gradient(ellipse at 90% 0%, #145348 0%, transparent 50%), linear-gradient(145deg, #0a2533, #091724); border-color: #2e6b67; }
header { padding-bottom: 1rem; border-bottom: 1px solid #ffffff18; align-items: center; }
.hero-icon { display: grid; place-items: center; width: 4rem; height: 4rem; flex: none; font-size: 2.5rem; color: var(--accent); border: 1px solid #ffffff30; border-radius: 50%; background: #ffffff08; box-shadow: 0 0 32px #56cfff18; }
.eyebrow { margin: 0 0 0.45rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.16em; font-size: 0.7rem; font-weight: 700; }
.meta { margin-top: 0.5rem; }
.highlights { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.8rem; }
.highlight { padding: 1.2rem; display: flex; flex-direction: column; gap: 0.35rem; background: linear-gradient(135deg, #ffffff0c, #ffffff03); border: 1px solid #ffffff20; border-radius: 14px; }
.highlight:first-child { background: linear-gradient(120deg, #24719a70, #0b324760); border-color: var(--accent); }
.golf .highlight:first-child { background: linear-gradient(120deg, #23795e80, #0b324760); }
.highlight > span { font-size: 0.8rem; color: #c1d4df; }
.highlight strong { font-size: clamp(2rem, 4vw, 3.5rem); color: var(--accent); line-height: 1.15; font-variant-numeric: tabular-nums; }
.highlight small { color: #a7bdcc; font-size: 0.75rem; }
.section-note { float: right; font-weight: 400; text-transform: none; letter-spacing: normal; }
.player-cards { display: grid; gap: 0.65rem; margin-bottom: 0.6rem; }
.player-card { border: 1px solid #ffffff16; border-radius: 12px; background: #06121e80; padding: 0.85rem; }
.player-card.won { border-color: color-mix(in srgb, var(--accent) 60%, transparent); background: linear-gradient(110deg, #ffffff09, #06121e80); }
.player-heading { display: flex; align-items: center; gap: 0.65rem; }
.rank { color: #91acbd; width: 1rem; font-variant-numeric: tabular-nums; }
.won .rank { color: var(--accent); font-weight: 800; }
.avatar { width: 2.4rem; height: 2.4rem; flex: none; border-radius: 50%; display: grid; place-items: center; background: color-mix(in srgb, var(--player) 30%, #0b2230); border: 1px solid var(--player); color: #fff; font-weight: 700; }
.player-name { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.player-name strong { overflow-wrap: anywhere; }
.player-name small, .player-score small, .player-details small { color: #a2b7c9; font-size: 0.7rem; }
.player-score { margin-left: auto; text-align: right; display: flex; flex-direction: column; }
.player-score b { color: var(--accent); font-size: 1.8rem; line-height: 1; font-variant-numeric: tabular-nums; }
.player-details { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.5rem; border-top: 1px solid #ffffff12; margin-top: 0.75rem; padding-top: 0.65rem; }
.player-details > div { display: flex; flex-direction: column; gap: 0.25rem; }
.player-details strong { font-size: 0.9rem; font-variant-numeric: tabular-nums; }
.arrow, .unchanged { color: #a2b7c9; font-size: 0.7rem; font-weight: 400; }
.change.improved { color: #69e9c0; }
.map-panel { background: #06121e60; border: 1px solid #ffffff16; border-radius: 14px; padding: 1rem; align-self: start; }
.card-scroll { padding: 0.65rem; background: #06121e80; border: 1px solid #ffffff16; border-radius: 12px; }
.card td { border: 3px solid #0a1b28; padding: 0.5rem; }
.legend { display: flex; gap: 0.7rem; flex-wrap: wrap; margin-top: 0.6rem; font-size: 0.65rem; color: #a2b7c9; }
.legend span::before { content: ''; display: inline-block; width: 0.45rem; height: 0.45rem; margin-right: 0.25rem; border-radius: 50%; background: #cdd3dc; }
.legend .great::before { background: #6fd68c; }.legend .good::before { background: #6fb2e0; }.legend .over::before { background: #d2a860; }.legend .blank::before { background: #a4666a; }
footer { align-items: center; border-top: 1px solid #ffffff18; padding-top: 1rem; }
.signoff { margin-right: auto; font-size: 0.85rem; color: #a2b7c9; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 580px) {
  .overlay { padding: 0.5rem; }
  .highlights { grid-template-columns: 1fr; gap: 0.5rem; }
  .highlight { display: grid; grid-template-columns: 1fr auto; padding: 0.8rem; }
  .highlight strong { grid-column: 2; grid-row: 1 / 3; align-self: center; }
  .highlight small { grid-column: 1; }
  .hero-icon { display: none; }
  .player-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .signoff { display: none; }
}
</style>
