<script setup lang="ts">
import { computed } from 'vue';
import { C, SIZE } from '../boardGeometry.ts';
import type { BoardEffect, EffectLevel } from '../store.ts';

/**
 * The burst that goes off on the dartboard when a turn busts or a Gotcha
 * knockback lands, and the label naming what happened.
 *
 * An overlay rather than something inside Dartboard.vue: the board is an input
 * surface with a lot of geometry in it, and none of this is clickable. Sharing
 * its viewBox is what keeps the two aligned, so the burst starts exactly under
 * the dart that caused it.
 *
 * The label sits on the board rather than in a corner toast because that is
 * where everyone is already looking when a dart lands. It shows even at
 * `level: "off"` -- the burst is decoration, the words are the news.
 *
 * The parent keys this component on `effect.key`, so two busts in a row replay
 * rather than the second one being swallowed by a still-running animation.
 */
const props = defineProps<{ effect: BoardEffect | null; level: EffectLevel }>();

/** Shards are only in the full burst; the subtle one is flash and shake. */
const SHARDS = 16;

const origin = computed(() => props.effect?.origin ?? { x: C, y: C });

/**
 * Deterministic debris, seeded from the effect's key.
 *
 * The same trick Celebration.vue uses for confetti: a re-render mid-animation
 * must not reshuffle the shards, or they visibly jump.
 */
const shards = computed(() => {
  const seed = props.effect?.key ?? 0;
  return Array.from({ length: SHARDS }, (_, i) => {
    const n = (seed * 89 + i * 37) % 997;
    // Spread evenly around the circle, then jitter, so the ring never looks
    // mechanically regular but also never leaves a bald patch.
    const angle = (i / SHARDS) * 360 + ((n % 24) - 12);
    const rad = (angle * Math.PI) / 180;
    const distance = 150 + (n % 130);
    return {
      i,
      dx: Math.cos(rad) * distance,
      dy: Math.sin(rad) * distance,
      length: 26 + (n % 30),
      width: 4 + (n % 5),
      angle,
      delay: (n % 90) / 1000,
      duration: 0.5 + ((n * 7) % 260) / 1000,
    };
  });
});
</script>

<template>
  <div v-if="effect" :key="effect.key" class="overlay">
    <svg
      v-if="level !== 'off'"
      :viewBox="`0 0 ${SIZE} ${SIZE}`"
      class="effect"
      :class="[effect.kind, level]"
      aria-hidden="true"
    >
      <!-- The flash: the whole board goes white for a frame or two. -->
      <circle class="flash" :cx="C" :cy="C" :r="SIZE / 2" />

      <!-- The shockwave, from where the dart landed rather than from centre. -->
      <circle class="wave" :cx="origin.x" :cy="origin.y" :r="1" :stroke="effect.color" />
      <circle class="wave wave-2" :cx="origin.x" :cy="origin.y" :r="1" :stroke="effect.color" />

      <g v-if="level === 'full'" :transform="`translate(${origin.x} ${origin.y})`">
        <rect
          v-for="s in shards"
          :key="s.i"
          class="shard"
          :x="0"
          :y="-s.width / 2"
          :width="s.length"
          :height="s.width"
          :rx="s.width / 2"
          :fill="effect.color"
          :style="{
            '--dx': `${s.dx}px`,
            '--dy': `${s.dy}px`,
            '--angle': `${s.angle}deg`,
            animationDelay: `${s.delay}s`,
            animationDuration: `${s.duration}s`,
          }"
        />
      </g>
    </svg>

    <!--
      Announced politely rather than assertively: the scoreboard beside it
      already changed, so this is a restatement, not an interruption.
    -->
    <div class="banner" :style="{ '--accent': effect.color }" role="status">
      <strong>{{ effect.title }}</strong>
      <span v-if="effect.body">{{ effect.body }}</span>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute;
  inset: 0;
  /* The board underneath is the input surface; none of this may swallow a click. */
  pointer-events: none;
  /* Makes the label's cqw sizes track the board rather than the window, so it
     stays proportionate on a phone and on the TV in the dartroom alike. */
  container-type: inline-size;
}

.effect {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/*
 * Sat across the middle of the board: the burst radiates outward from the
 * dart, so the centre band is the one place the words stay legible.
 */
.banner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: 88%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  padding: 0.6rem 1.4rem;
  border-radius: 14px;
  text-align: center;
  background: rgba(8, 10, 14, 0.82);
  border: 2px solid var(--accent);
  box-shadow: 0 0 30px rgba(0, 0, 0, 0.55), 0 0 22px color-mix(in srgb, var(--accent) 45%, transparent);
  animation: banner 2600ms cubic-bezier(0.15, 0.8, 0.3, 1) both;
}
.banner strong {
  font-size: clamp(1.5rem, 6cqw, 2.4rem);
  line-height: 1.1;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8);
}
.banner span {
  font-size: clamp(0.8rem, 2.6cqw, 1rem);
  color: #e7ebf2;
}

.flash {
  fill: #fff;
  opacity: 0;
  animation: flash 260ms ease-out both;
}
/* A knockback is someone else's doing, so it hits softer than your own bust. */
.effect.gotcha .flash { animation-duration: 200ms; }

.wave {
  fill: none;
  stroke-width: 22;
  opacity: 0;
  animation: wave 620ms cubic-bezier(0.15, 0.7, 0.3, 1) both;
}
.wave-2 { animation-delay: 110ms; animation-duration: 760ms; stroke-width: 10; }

.shard {
  animation-name: shard;
  animation-timing-function: cubic-bezier(0.1, 0.75, 0.3, 1);
  animation-fill-mode: both;
  transform-box: fill-box;
  transform-origin: 0 50%;
}

@keyframes flash {
  0%   { opacity: 0.55; }
  100% { opacity: 0; }
}

@keyframes wave {
  0%   { r: 10; opacity: 0.85; stroke-width: 30; }
  100% { r: 460; opacity: 0; stroke-width: 2; }
}

/*
 * Punch in, hold long enough to read, then fade. The hold is most of it: the
 * timings here and EFFECT_MS in store.ts have to stay in step, or the label
 * would be pulled off screen mid-sentence.
 */
@keyframes banner {
  0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
  8%   { opacity: 1; transform: translate(-50%, -50%) scale(1.06); }
  14%  { transform: translate(-50%, -50%) scale(1); }
  78%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.94); }
}

@keyframes shard {
  0%   { transform: rotate(var(--angle)) translate(0, 0) scale(0.4); opacity: 1; }
  100% { transform: rotate(var(--angle)) translate(var(--dx), var(--dy)) scale(1); opacity: 0; }
}

/*
 * A full-board burst is exactly the kind of motion that causes trouble, so
 * honour the preference and keep only a brief tint -- the same call
 * Celebration.vue makes about its confetti.
 */
@media (prefers-reduced-motion: reduce) {
  .wave, .shard { display: none; }
  .flash { animation-duration: 400ms; }
  /* The label still has to appear and go away, so it only loses the movement. */
  .banner { animation-name: banner-fade; }
}

@keyframes banner-fade {
  0%   { opacity: 0; }
  8%   { opacity: 1; }
  85%  { opacity: 1; }
  100% { opacity: 0; }
}
</style>
