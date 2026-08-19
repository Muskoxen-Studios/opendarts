<script setup lang="ts">
import { computed } from 'vue';

export interface Celebration {
  key: number;
  playerName: string;
  playerColor: string;
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: string | null;
}

const props = defineProps<{ celebration: Celebration | null; queued: number }>();
const emit = defineEmits<{ (e: 'dismiss'): void }>();

const tierLabel = computed(() => props.celebration?.tier ?? 'unlocked');

/** Deterministic confetti so the burst does not reshuffle on every re-render. */
const confetti = computed(() => {
  const seedBase = props.celebration?.key ?? 0;
  const colors = ['#4f8ef7', '#e0a458', '#3f9d54', '#d8453f', '#a06cd5', '#41b8c4'];
  return Array.from({ length: 60 }, (_, i) => {
    const seed = (seedBase * 97 + i * 31) % 1000;
    return {
      i,
      left: (seed % 100) + Math.random() * 0.001,
      delay: ((seed * 7) % 900) / 1000,
      duration: 2.2 + ((seed * 13) % 180) / 100,
      color: colors[seed % colors.length],
      drift: ((seed % 40) - 20) * 3,
      spin: ((seed * 3) % 720) - 360,
      size: 6 + (seed % 8),
    };
  });
});
</script>

<template>
  <Transition name="fade">
    <div
      v-if="celebration"
      class="overlay"
      role="alertdialog"
      aria-live="assertive"
      :aria-label="`Achievement unlocked: ${celebration.name}`"
      @click="emit('dismiss')"
    >
      <div class="confetti" aria-hidden="true">
        <i
          v-for="c in confetti"
          :key="c.i"
          :style="{
            left: `${c.left}%`,
            background: c.color,
            width: `${c.size}px`,
            height: `${c.size * 1.6}px`,
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.duration}s`,
            '--drift': `${c.drift}px`,
            '--spin': `${c.spin}deg`,
          }"
        />
      </div>

      <div class="card" :class="celebration.tier ?? 'none'" @click.stop>
        <p class="eyebrow">{{ tierLabel }} &middot; achievement unlocked</p>
        <div class="icon">{{ celebration.icon }}</div>
        <h2>{{ celebration.name }}</h2>
        <p class="desc">{{ celebration.description }}</p>
        <p class="who" :style="{ '--accent': celebration.playerColor }">
          {{ celebration.playerName }}
        </p>
        <button class="dismiss" @click="emit('dismiss')">
          {{ queued > 0 ? `Next (${queued} more)` : 'Nice' }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgb(6 8 11 / 78%);
  backdrop-filter: blur(3px);
  overflow: hidden;
}

.card {
  position: relative;
  text-align: center;
  padding: 2.5rem 3rem;
  border-radius: 20px;
  background: linear-gradient(180deg, #1c222c, #12161c);
  border: 2px solid #3a4250;
  box-shadow: 0 30px 90px rgb(0 0 0 / 60%);
  animation: pop 520ms cubic-bezier(0.2, 1.3, 0.4, 1) both;
  max-width: min(92vw, 30rem);
}
.card.gold   { border-color: #d9a839; box-shadow: 0 0 90px rgb(217 168 57 / 30%), 0 30px 90px rgb(0 0 0 / 60%); }
.card.silver { border-color: #9aa4b2; box-shadow: 0 0 90px rgb(154 164 178 / 24%), 0 30px 90px rgb(0 0 0 / 60%); }
.card.bronze { border-color: #b3733f; box-shadow: 0 0 90px rgb(179 115 63 / 24%), 0 30px 90px rgb(0 0 0 / 60%); }

.eyebrow {
  margin: 0 0 0.6rem;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #8b93a1;
}
.icon {
  font-size: 5.5rem;
  line-height: 1;
  animation: bounce 1.1s ease-in-out 0.25s 2 both;
}
h2 { margin: 0.6rem 0 0.35rem; font-size: 2rem; letter-spacing: -0.01em; }
.desc { margin: 0; color: #b9c0cc; }
.who {
  margin: 1rem 0 0;
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--accent);
}
.dismiss {
  margin-top: 1.4rem;
  background: #4f8ef7;
  border: none;
  color: #fff;
  font: inherit;
  font-weight: 600;
  border-radius: 999px;
  padding: 0.6rem 1.8rem;
  cursor: pointer;
}

.confetti { position: absolute; inset: 0; pointer-events: none; }
.confetti i {
  position: absolute;
  top: -8vh;
  border-radius: 2px;
  animation-name: fall;
  animation-timing-function: linear;
  animation-fill-mode: both;
}

@keyframes fall {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); opacity: 1; }
  100% { transform: translate3d(var(--drift), 112vh, 0) rotate(var(--spin)); opacity: 0.9; }
}
@keyframes pop {
  0%   { transform: scale(0.7) translateY(18px); opacity: 0; }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}
@keyframes bounce {
  0%, 100% { transform: translateY(0) scale(1); }
  50%      { transform: translateY(-14px) scale(1.08); }
}

.fade-enter-active, .fade-leave-active { transition: opacity 220ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* A full-screen burst is exactly the kind of motion that causes trouble, so
   honour the user's preference and keep only the static card. */
@media (prefers-reduced-motion: reduce) {
  .confetti { display: none; }
  .card, .icon { animation: none; }
}
</style>
