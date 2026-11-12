<script setup lang="ts">
import { conquest, type View } from '../gameDetail.ts';
const props = defineProps<{ view: View }>();
function factionName(id: string | null) {
  return props.view.players.find((p) => p.playerId === id)?.name ?? 'None';
}
function homeLabel(home: string) { return home.replace(':outer', props.view.players[0]?.detail.splitTerritories ? ' outer' : ''); }
function homeDamage(id: string) {
  const p = props.view.players.find((p) => p.playerId === id)!;
  const t = conquest(p).territories.find((t) => t.id === conquest(p).home);
  return t?.homeId === id ? `${t.marks}/${t.required}` : 'captured';
}
</script>

<template>
  <section class="conquest-panel" aria-label="Conquest factions">
    <p class="goal">Last independent faction wins</p>
    <article v-for="p in view.players" :key="p.playerId" :class="{ active: p.isActive, 'god-armed': conquest(p).godPower, out: conquest(p).eliminated && !conquest(p).canComeback }"
      :style="{ '--faction': view.players.find((ally) => ally.playerId === conquest(p).factionId)?.color ?? '#666' }">
      <div class="line"><strong>{{ p.name }}</strong><span>{{ p.score }} territories</span></div>
      <div class="line"><span>★ {{ homeLabel(conquest(p).home) }}</span><span>{{ homeDamage(p.playerId) }}</span></div>
      <p v-if="conquest(p).eliminated">{{ conquest(p).canComeback ? 'Foothold: reclaim your home to return' : 'Eliminated' }}</p>
      <p v-else-if="conquest(p).factionId !== p.playerId">Fighting for {{ factionName(conquest(p).factionId) }}<span v-if="conquest(p).canComeback"> · reclaim home to become independent</span></p>
      <p v-else>Independent faction</p>
      <p v-if="conquest(p).godPower" class="god-power" role="status">⚡ Power of God armed<br />Hit an enemy ★ to capture its base and all its territory instantly.</p>
      <p v-else-if="conquest(p).canInvokeGod" class="god-available">Uniquely last · hit inner bull to unlock Power of God.</p>
    </article>
    <p class="help">3 marks capture a field. Friendly hits defend; enemy hits sabotage from anywhere.
      <span v-if="view.players[0]?.detail.fortifiedHomes">Homes take 9 permanent marks and cannot be defended by hitting them.</span>
    </p>
  </section>
</template>

<style scoped>
.conquest-panel { display: grid; gap: .65rem; }
.goal { margin: .3rem 0; color: var(--ui-secondary); }
article { border: 1px solid var(--ui-border); border-left: 5px solid var(--faction); border-radius: 10px; padding: .8rem; background: var(--ui-surface); }
article.active { outline: 2px solid var(--faction); }
article.out { opacity: .5; }
article.god-armed { border-color: #ffd166; box-shadow: 0 0 18px #ffd16630; }
article .god-power { color: #ffe49a; font-weight: 700; font-size: .95rem; }
article .god-available { color: #ffd166; }
.line { display: flex; justify-content: space-between; gap: .5rem; line-height: 1.6; }
article p, .help { margin: .4rem 0 0; font-size: .8rem; color: var(--ui-secondary); line-height: 1.5; }
</style>
