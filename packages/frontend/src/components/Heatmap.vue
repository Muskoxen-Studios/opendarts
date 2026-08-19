<script setup lang="ts">
import { computed } from 'vue';
import { BOARD_MM, type Segment } from '@darts/schema';
import {
  boardCells,
  BULL_INNER_R,
  BULL_OUTER_R,
  C,
  mmToSvg,
  NUMBERS,
  r,
  SIZE,
} from '../boardGeometry.ts';
import type { Heatmap } from '../store.ts';

/**
 * Where darts landed.
 *
 * Deliberately built on segment counts, which scoring always knows, rather than
 * on coordinates, which the board does not yet give us. When coordinates are
 * present they are drawn on top as individual darts -- so the map gets sharper
 * over time instead of being unavailable until then.
 */
const props = withDefaults(
  defineProps<{
    heatmap: Heatmap;
    /** Tint for the density fill and the plotted darts. */
    color?: string;
    /** Hide the individual darts even when coordinates exist. */
    dots?: boolean;
  }>(),
  { color: '#ff8a3d', dots: true },
);

const cells = boardCells();

const counts = computed(() => {
  const map = new Map<string, number>();
  for (const c of props.heatmap.cells) map.set(`${c.number}:${c.ring}`, c.count);
  return map;
});

function countOf(segment: Segment): number {
  return counts.value.get(`${segment.number}:${segment.ring}`) ?? 0;
}

/**
 * Density is drawn on a square-root scale. A linear one lets a single hot
 * treble wash out every other segment, which hides exactly the pattern the map
 * is for.
 */
function opacityOf(count: number): number {
  const max = props.heatmap.max || 1;
  if (count <= 0) return 0;
  return 0.12 + 0.88 * Math.sqrt(count / max);
}

const dots = computed(() =>
  props.dots ? props.heatmap.dots.map((d) => ({ ...mmToSvg(d), playerId: d.playerId })) : [],
);

const bullCount = computed(() => countOf({ number: 25, ring: 'BULL' }));
const outerBullCount = computed(() => countOf({ number: 25, ring: 'OUTER_BULL' }));
const missCount = computed(() => props.heatmap.byNumber[0] ?? 0);

/** The segments a player hits most, as a plain-language caption. */
const hottest = computed(() =>
  props.heatmap.cells
    .filter((c) => c.ring !== 'MISS')
    .slice(0, 3)
    .map((c) => ({ label: label(c.number, c.ring), count: c.count })),
);

function label(number: number, ring: string): string {
  if (ring === 'BULL') return 'BULL';
  if (ring === 'OUTER_BULL') return '25';
  if (ring === 'DOUBLE') return `D${number}`;
  if (ring === 'TRIPLE') return `T${number}`;
  return `S${number}`;
}
</script>

<template>
  <figure class="heat">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" role="img" aria-label="Heatmap of where darts landed">
      <circle :cx="C" :cy="C" :r="r(BOARD_MM.BOARD_OUTER) + 14" fill="#0c0e12" />

      <!-- The board itself, muted, so empty segments are still readable. -->
      <path
        v-for="(w, i) in cells"
        :key="`base-${i}`"
        :d="w.d"
        :fill="w.dark ? '#1a1e25' : '#22272f'"
        stroke="#0c0e12"
        stroke-width="1.5"
      />

      <path
        v-for="(w, i) in cells"
        :key="`heat-${i}`"
        :d="w.d"
        :fill="color"
        :fill-opacity="opacityOf(countOf(w.segment))"
        stroke="none"
      >
        <title>{{ w.label }}: {{ countOf(w.segment) }}</title>
      </path>

      <circle :cx="C" :cy="C" :r="BULL_OUTER_R" fill="#22272f" stroke="#0c0e12" stroke-width="1.5" />
      <circle :cx="C" :cy="C" :r="BULL_OUTER_R" :fill="color" :fill-opacity="opacityOf(outerBullCount)" />
      <circle :cx="C" :cy="C" :r="BULL_INNER_R" fill="#2b3039" />
      <circle :cx="C" :cy="C" :r="BULL_INNER_R" :fill="color" :fill-opacity="opacityOf(bullCount)" />

      <circle
        v-for="(d, i) in dots"
        :key="`dot-${i}`"
        :cx="d.x"
        :cy="d.y"
        r="7"
        class="dart"
        :fill="color"
      />

      <text
        v-for="n in NUMBERS"
        :key="n.number"
        :x="n.x" :y="n.y"
        class="number"
        text-anchor="middle"
        dominant-baseline="central"
      >{{ n.number }}</text>
    </svg>

    <figcaption>
      <span>{{ heatmap.total }} darts</span>
      <span v-if="missCount">{{ missCount }} off the board</span>
      <span v-for="h in hottest" :key="h.label" class="hot">{{ h.label }} &times;{{ h.count }}</span>
      <!--
        Coordinates arrive only from sources that report them. Saying so is
        better than silently showing a map with no darts plotted on it.
      -->
      <span v-if="dots.length === 0 && heatmap.total > 0" class="note">
        segment density &mdash; no dart coordinates recorded
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.heat { margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
svg { width: 100%; height: auto; display: block; }
.dart { stroke: #0c0e12; stroke-width: 2; opacity: 0.9; }
.number { fill: #6c7480; font: 600 42px system-ui, sans-serif; pointer-events: none; }
figcaption {
  display: flex; flex-wrap: wrap; gap: 0.5rem;
  font-size: 0.72rem; color: #8b93a1; font-variant-numeric: tabular-nums;
}
.hot { color: #e0a458; }
.note { color: #6b7280; font-style: italic; }
</style>
