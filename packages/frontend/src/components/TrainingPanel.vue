<script setup lang="ts">
import { computed } from 'vue';
import type { MatchView } from '@darts/schema';
const props = defineProps<{ player: Pick<MatchView['players'][number], 'detail' | 'legsWon'>; gameType: string; round: number }>();
const d = computed(() => props.player.detail);
const hitRate = computed(() => Number(d.value.darts) > 0 ? `${Math.round(Number(d.value.hits) / Number(d.value.darts) * 100)}%` : '–');
const target = computed(() => d.value.targetLabel ?? (d.value.target === 25 ? 'Bull' : d.value.target));
const metrics = computed(() => {
  if (props.gameType === 'randomcheckout') return [
    { label: 'Starting checkout', value: d.value.startScore }, { label: 'Visits used', value: `${d.value.turnsUsed}/${d.value.maxRounds}` },
    { label: 'Finish', value: d.value.outMode }, { label: 'Legs checked out', value: props.player.legsWon },
  ];
  if (props.gameType === '121') return [
    { label: 'Level', value: d.value.level }, { label: 'Attempts completed', value: `${d.value.attempts}/${d.value.maxRounds}` },
    { label: 'Visits used', value: `${d.value.turnsUsed}/${d.value.visitsPerAttempt}` }, { label: 'Checkouts', value: d.value.checkouts },
    { label: 'Highest target', value: d.value.highest }, { label: 'Safehouse', value: d.value.safehouse },
  ];
  if (props.gameType === 'segmenttraining') return [
    { label: 'Hits', value: `${d.value.hits}${d.value.endsAfter === 'hits' ? `/${d.value.goal}` : ''}` },
    { label: 'Darts', value: `${d.value.darts}${d.value.endsAfter === 'darts' ? `/${d.value.goal}` : ''}` },
    { label: 'Hit rate', value: hitRate.value },
  ];
  return [{ label: 'Round', value: `${props.round}/${d.value.rounds}` }, { label: 'Hits', value: d.value.hits },
    { label: 'Hit rate', value: hitRate.value }, ...(props.gameType === 'bobs27' ? [{ label: 'Peak score', value: d.value.highest }] : [])];
});
</script>
<template>
  <section class="training-panel" aria-label="Training progress">
    <strong v-if="target !== null && target !== undefined" class="training-target">Target {{ target }}</strong>
    <dl><div v-for="metric in metrics" :key="metric.label"><dt>{{ metric.label }}</dt><dd>{{ metric.value }}</dd></div></dl>
    <p v-if="d.pending">Attempt complete · next target {{ d.level }}</p>
    <p v-if="d.eliminated">Session ended: score reached zero or below.</p>
    <div v-if="Array.isArray(d.visits) && d.visits.length" class="training-visits" aria-label="Visit scores"><span v-for="(visit, index) in d.visits" :key="index" :title="`Visit ${index + 1}`">{{ visit }}</span></div>
  </section>
</template>
<style scoped>
.training-panel { display: grid; gap: 0.6rem; }.training-target { color: var(--ui-accent); font-size: 1.25rem; }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: 0.5rem; margin: 0; }
dl > div { padding: 0.5rem; border: 1px solid var(--ui-border-soft); border-radius: 8px; background: var(--ui-surface-deep); }
dt { font-size: 0.7rem; color: var(--ui-muted); }dd { margin: 0.2rem 0 0; font-size: 1rem; font-weight: 650; }
p { margin: 0; font-size: 0.85rem; color: var(--ui-secondary); }
.training-visits { display: flex; flex-wrap: wrap; gap: 0.3rem; }.training-visits span { padding: 0.25rem 0.5rem; border-radius: 5px; background: var(--ui-surface); font-variant-numeric: tabular-nums; }
</style>
