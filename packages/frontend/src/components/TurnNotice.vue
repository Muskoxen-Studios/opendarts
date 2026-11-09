<script setup lang="ts">
defineProps<{ stuck: boolean; awaitingTakeout: boolean; correcting: boolean }>();
const emit = defineEmits<{ (e: 'forceTakeout'): void }>();
</script>

<template>
  <div class="turn-notice" role="status" aria-live="polite" aria-atomic="true">
    <!-- Every notice participates in sizing; only the active one is visible.
         This reserves the tallest wrapped message at the current width. -->
    <p :class="{ visible: stuck }" :aria-hidden="!stuck" class="takeout">
      Takeout seems stuck.
      <button @click="emit('forceTakeout')">Force takeout</button>
    </p>
    <p :class="{ visible: !stuck && awaitingTakeout }" :aria-hidden="stuck || !awaitingTakeout" class="takeout">
      Turn complete. Remove your darts to hand over.
    </p>
    <p :class="{ visible: !stuck && !awaitingTakeout && correcting }" :aria-hidden="stuck || awaitingTakeout || !correcting">
      Click the correct segment, even after a bust or handover.
    </p>
    <p :class="{ visible: !stuck && !awaitingTakeout && !correcting }" :aria-hidden="stuck || awaitingTakeout || correcting">
      Click the board to simulate a dart.
    </p>
  </div>
</template>

<style scoped>
.turn-notice { display: grid; align-items: center; color: var(--ui-muted); font-size: 0.8rem; line-height: 1.45; text-align: center; }
p { grid-area: 1 / 1; margin: 0; visibility: hidden; overflow-wrap: anywhere; }
p.visible { visibility: visible; }
.takeout { color: #e0a458; font-weight: 600; }
button { background: var(--ui-surface-raised); color: var(--ui-text); border: 1px solid var(--ui-border); border-radius: 6px; padding: 0.25rem 0.45rem; margin-top: 0.2rem; font-size: inherit; }
</style>
