<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { BOARD_MM, parseSegmentLabel } from '@darts/schema';
import {
  boardCells,
  BULL_INNER_R,
  BULL_OUTER_R,
  C,
  mmToSvg,
  r,
  segmentCentre,
  SIZE,
} from '../boardGeometry.ts';

/**
 * Plays the winning turn back, dart by dart.
 *
 * Darts land at their real coordinates when the source reported them, and at
 * the centre of the segment they scored otherwise -- which is all the label
 * alone can tell us, and still shows the shot that won the match.
 */
const props = withDefaults(
  defineProps<{
    darts: Array<{ label: string; value: number; coords: { x: number; y: number } | null }>;
    color?: string;
    /** Milliseconds between darts. */
    interval?: number;
  }>(),
  { color: '#ffd166', interval: 750 },
);

const shown = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const reduceMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const cells = boardCells();

const marks = computed(() =>
  props.darts.map((d) => {
    if (d.coords) return { ...mmToSvg(d.coords), label: d.label, exact: true };
    const segment = parseSegmentLabel(d.label);
    const centre = segment ? segmentCentre(segment) : { x: C, y: C };
    return { ...centre, label: d.label, exact: false };
  }),
);

const total = computed(() => props.darts.reduce((sum, d) => sum + d.value, 0));

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function replay(): void {
  stop();
  // Respecting reduced motion means showing the result, not animating to it.
  if (reduceMotion || props.darts.length === 0) {
    shown.value = props.darts.length;
    return;
  }
  shown.value = 0;
  timer = setInterval(() => {
    shown.value += 1;
    if (shown.value >= props.darts.length) stop();
  }, props.interval);
}

onMounted(replay);
onBeforeUnmount(stop);
watch(() => props.darts, replay);
</script>

<template>
  <div class="replay">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" role="img" aria-label="Replay of the winning turn">
      <circle :cx="C" :cy="C" :r="r(BOARD_MM.BOARD_OUTER) + 14" fill="#0c0e12" />
      <path
        v-for="(w, i) in cells"
        :key="i"
        :d="w.d"
        :fill="
          w.segment.ring === 'MISS'
            ? (w.dark ? '#15181d' : '#191d23')
            : w.segment.ring === 'DOUBLE' || w.segment.ring === 'TRIPLE'
              ? (w.dark ? '#8f3330' : '#2c6b3c')
              : (w.dark ? '#20242b' : '#cdc8b4')
        "
        stroke="#0c0e12"
        stroke-width="1.5"
      />
      <circle :cx="C" :cy="C" :r="BULL_OUTER_R" fill="#2c6b3c" stroke="#0c0e12" stroke-width="1.5" />
      <circle :cx="C" :cy="C" :r="BULL_INNER_R" fill="#8f3330" />

      <g v-for="(m, i) in marks.slice(0, shown)" :key="i">
        <circle :cx="m.x" :cy="m.y" :r="26" class="halo" :fill="color" />
        <circle :cx="m.x" :cy="m.y" :r="11" :fill="color" stroke="#0c0e12" stroke-width="3" />
        <text :x="m.x" :y="m.y - 40" class="tag" text-anchor="middle">{{ m.label }}</text>
      </g>
    </svg>

    <div class="bar">
      <span class="darts">
        <b v-for="(d, i) in darts" :key="i" :class="{ on: i < shown }">{{ d.label }}</b>
      </span>
      <span class="total">{{ total }}</span>
      <button @click="replay">Replay</button>
    </div>
  </div>
</template>

<style scoped>
.replay { display: flex; flex-direction: column; gap: 0.5rem; }
svg { width: 100%; height: auto; max-width: 340px; display: block; margin: 0 auto; }
.halo { opacity: 0.22; }
.tag {
  fill: #e8e6e1; font: 700 40px system-ui, sans-serif;
  paint-order: stroke; stroke: #0c0e12; stroke-width: 8px;
}
.bar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; justify-content: center; }
.darts { display: flex; gap: 0.3rem; }
.darts b {
  background: #14171c; border: 1px solid #262b33; border-radius: 5px;
  padding: 0.15rem 0.45rem; font-size: 0.8rem; color: #4a5260; transition: color 150ms ease;
}
.darts b.on { color: #e8e6e1; border-color: #3a424f; }
.total { font-weight: 700; font-variant-numeric: tabular-nums; }
.bar button {
  background: #14171c; border: 1px solid #262b33; color: #cdd3dc;
  border-radius: 6px; padding: 0.3rem 0.7rem; cursor: pointer; font: inherit; font-size: 0.8rem;
}
@media (prefers-reduced-motion: reduce) {
  .darts b { transition: none; }
}
</style>
