<script setup lang="ts">
import { computed, ref } from 'vue';
import { parseSegmentLabel, type Coords, type Segment } from '@darts/schema';
import {
  boardCells,
  BULL_INNER_R,
  BULL_OUTER_R,
  C,
  mmToSvg,
  NUMBERS,
  r,
  segmentCentre,
  SIZE,
  svgToMm,
} from '../boardGeometry.ts';
import { BOARD_MM } from '@darts/schema';

const props = defineProps<{
  /**
   * Segments to light up, strongest first: the checkout route for the rest of
   * the turn. The first is the dart to throw now, the rest are the follow-ups.
   */
  highlight?: Segment[];
  /** Whole numbers to light up, for games that aim at a number, not a ring. */
  highlightNumbers?: number[];
  /**
   * Darts already thrown this turn, plotted on the board. Lands at the real
   * coordinates when the source reported them, and at the centre of the
   * segment it scored otherwise. Stays put -- including through a bust or a
   * finish -- until the turn is released (see `MatchView.awaitingTakeout`),
   * which is what lets a player see their own three darts before the
   * highlight moves on.
   */
  marks?: readonly { readonly label: string; readonly coords: { readonly x: number; readonly y: number } | null }[];
  markColor?: string;
  /** Shared Minefield state, keyed by the base number (both bulls share 25). */
  minefield?: readonly {
    readonly number: number;
    readonly hp: number;
    readonly multiplier: number;
  }[];
}>();

const emit = defineEmits<{ (e: 'throw', payload: { segment: Segment; coords: Coords }): void }>();

const WHITE = '#f5f0dc';
const BLACK = '#20242b';
const RED = '#d8453f';
const GREEN = '#3f9d54';

const cells = boardCells();
const mineNumbers = computed(() => new Map((props.minefield ?? []).map((cell) => [cell.number, cell])));
const mineMarkers = computed(() => (props.minefield ?? []).map((cell) => ({
  ...cell,
  ...segmentCentre({ number: cell.number, ring: cell.number === 25 ? 'BULL' : 'SINGLE_OUTER' }),
  description: cell.hp > 0
    ? `${cell.number === 25 ? 'Bull' : cell.number}: ${cell.hp} HP, next mine ${cell.multiplier}×`
    : `${cell.number === 25 ? 'Bull' : cell.number}: mine ${cell.multiplier}×, penalty ${Math.round(cell.number * cell.multiplier)}, double/triple defuses, single explodes`,
})));
function isMine(number: number): boolean {
  return mineNumbers.value.get(number)?.hp === 0;
}
function mineDescription(number: number): string {
  return mineMarkers.value.find((cell) => cell.number === number)?.description ?? '';
}
const svg = ref<SVGSVGElement | null>(null);

function fillOf(cell: (typeof cells)[number]): string {
  switch (cell.segment.ring) {
    case 'MISS':
      return cell.dark ? '#15181d' : '#191d23';
    case 'DOUBLE':
    case 'TRIPLE':
      return cell.dark ? RED : GREEN;
    default:
      return cell.dark ? BLACK : WHITE;
  }
}

const keyOf = (s: Segment): string => `${s.number}:${s.ring}`;

/**
 * Rank of a highlighted segment, or -1. Rank 0 is the dart to throw now and is
 * drawn brightest; later darts of the route are dimmer, so the board reads as
 * an ordered route rather than three equal targets.
 */
const ranks = computed(() => {
  const map = new Map<string, number>();
  (props.highlight ?? []).forEach((s, i) => {
    const key = keyOf(s);
    if (!map.has(key)) map.set(key, i);
  });
  return map;
});

const numberTargets = computed(() => new Set(props.highlightNumbers ?? []));

function rankOf(segment: Segment): number {
  const byNumber = numberTargets.value.has(segment.number) && segment.ring !== 'MISS';
  if (byNumber) return 0;
  return ranks.value.get(keyOf(segment)) ?? -1;
}

/**
 * Where the click landed, in board millimetres.
 *
 * The virtual board knows exactly where it was hit, so simulated darts carry
 * real coordinates. Board-sourced darts still arrive without them, which is why
 * nothing downstream may depend on this.
 */
function coordsFrom(ev: MouseEvent): Coords {
  const el = svg.value;
  if (!el) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * SIZE;
  const y = ((ev.clientY - rect.top) / rect.height) * SIZE;
  return svgToMm(x, y);
}

function fire(segment: Segment, ev: MouseEvent): void {
  emit('throw', { segment, coords: coordsFrom(ev) });
}

const dartMarks = computed(() =>
  (props.marks ?? []).map((m) => {
    if (m.coords) return { ...mmToSvg(m.coords), label: m.label };
    const segment = parseSegmentLabel(m.label);
    return { ...(segment ? segmentCentre(segment) : { x: C, y: C }), label: m.label };
  }),
);
</script>

<template>
  <svg
    ref="svg"
    :viewBox="`0 0 ${SIZE} ${SIZE}`"
    class="board"
    role="group"
    aria-label="Dartboard"
  >
    <circle :cx="C" :cy="C" :r="r(BOARD_MM.BOARD_OUTER) + 14" fill="#0c0e12" />

    <path
      v-for="(w, i) in cells"
      :key="i"
      :d="w.d"
      :fill="fillOf(w)"
      class="wedge"
      :class="{ target: rankOf(w.segment) === 0, 'target-later': rankOf(w.segment) > 0, mine: isMine(w.segment.number), fragile: mineNumbers.get(w.segment.number)?.hp === 1 }"
      :aria-label="w.label"
      @click="fire(w.segment, $event)"
    >
      <title v-if="mineNumbers.has(w.segment.number)">{{ mineDescription(w.segment.number) }}</title>
    </path>

    <circle
      :cx="C" :cy="C" :r="BULL_OUTER_R"
      :fill="GREEN" class="wedge"
      :class="{ mine: isMine(25), target: rankOf({ number: 25, ring: 'OUTER_BULL' }) === 0, 'target-later': rankOf({ number: 25, ring: 'OUTER_BULL' }) > 0 }"
      aria-label="Outer bull"
      @click="fire({ number: 25, ring: 'OUTER_BULL' }, $event)"
    >
      <title v-if="mineNumbers.has(25)">{{ mineDescription(25) }}</title>
    </circle>
    <circle
      :cx="C" :cy="C" :r="BULL_INNER_R"
      :fill="RED" class="wedge"
      :class="{ mine: isMine(25), target: rankOf({ number: 25, ring: 'BULL' }) === 0, 'target-later': rankOf({ number: 25, ring: 'BULL' }) > 0 }"
      aria-label="Bull"
      @click="fire({ number: 25, ring: 'BULL' }, $event)"
    >
      <title v-if="mineNumbers.has(25)">{{ mineDescription(25) }}</title>
    </circle>

    <!--
      Outlines are drawn after every fill so a highlight is never painted over
      by the neighbouring wedge, and they ignore pointer events so the ring does
      not swallow clicks meant for the segment underneath.
    -->
    <path
      v-for="(w, i) in cells.filter((c) => rankOf(c.segment) >= 0)"
      :key="`ring-${i}`"
      :d="w.d"
      class="outline"
      :class="rankOf(w.segment) === 0 ? 'now' : 'later'"
    />

    <text
      v-for="n in NUMBERS"
      :key="n.number"
      :x="n.x" :y="n.y"
      class="number"
      :class="{ lit: numberTargets.has(n.number) }"
      text-anchor="middle"
      dominant-baseline="central"
    >{{ n.number }}</text>

    <!-- Pointer-transparent badges preserve the existing board input and dart coordinates. -->
    <g v-for="cell in mineMarkers" :key="`mine-${cell.number}`"
      class="mine-marker" :class="{ armed: cell.hp === 0 }"
      :transform="`translate(${cell.x} ${cell.y})`" role="img" :aria-label="cell.description">
      <title>{{ cell.description }}</title>
      <rect x="-38" y="-29" width="76" :height="cell.hp === 0 ? 75 : 56" rx="15" />
      <template v-if="cell.hp === 0">
        <circle cy="-4" r="15" fill="#ffe4e6" />
        <path d="M 7 -17 L 13 -25 L 23 -22 M 22 -27 L 27 -32 M 27 -20 L 34 -20"
          fill="none" stroke="#ffe4e6" stroke-width="4" stroke-linecap="round" />
        <text y="33" class="mine-multiplier">{{ cell.multiplier }}×</text>
      </template>
      <text v-else y="10" class="mine-hp">{{ cell.hp }}</text>
    </g>

    <g v-for="(m, i) in dartMarks" :key="`mark-${i}`" class="dart-mark">
      <circle :cx="m.x" :cy="m.y" :r="24" class="halo" :fill="props.markColor ?? '#ffd166'" />
      <circle :cx="m.x" :cy="m.y" :r="10" :fill="props.markColor ?? '#ffd166'" stroke="#0c0e12" stroke-width="3" />
    </g>
  </svg>
</template>

<style scoped>
.board {
  width: 100%;
  height: auto;
  display: block;
}
.wedge {
  cursor: pointer;
  stroke: #0c0e12;
  stroke-width: 1.5;
  transition: filter 90ms ease;
}
.wedge:hover {
  filter: brightness(1.45);
}
.wedge:active {
  filter: brightness(0.8);
}
/* The dart to throw now, and the rest of the route behind it. */
.wedge.target { filter: brightness(1.5) saturate(1.2); }
.wedge.target-later { filter: brightness(1.2); }

.wedge.mine { fill: #b52240; animation: mine-blink 1.6s ease-in-out infinite; }
.wedge.fragile { stroke: #efb950; stroke-width: 3; }
@keyframes mine-blink {
  0%, 100% { fill: #7f1830; }
  50% { fill: #ff3658; }
}
.mine-marker { pointer-events: none; }
.mine-marker rect { fill: #102a38; stroke: #8ab8ca; stroke-width: 2; }
.mine-marker.armed rect { fill: #591428; stroke: #ff8199; }
.mine-marker text { fill: #f0faff; text-anchor: middle; font: 700 25px system-ui, sans-serif; }
.mine-marker.armed text { fill: #ffe4e6; }
.mine-marker .mine-hp { font-size: 36px; }
.mine-marker .mine-multiplier { font-size: 30px; }

.dart-mark { pointer-events: none; }
.dart-mark .halo { opacity: 0.22; }

.outline { fill: none; pointer-events: none; }
.outline.now { stroke: #ffd166; stroke-width: 5; }
.outline.later { stroke: #ffd166; stroke-width: 3; opacity: 0.45; }

.number {
  fill: #e8e6e1;
  font: 600 46px system-ui, sans-serif;
  pointer-events: none;
}
.number.lit { fill: #ffd166; }

@media (prefers-reduced-motion: reduce) {
  .wedge { transition: none; }
  .wedge.mine { animation: none; fill: #dd2c4c; }
}
</style>
