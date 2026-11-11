<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { store } from '../store.ts';

const props = defineProps<{ playerId: string }>();
const profile = computed(() => store.profiles.find((p) => p.id === props.playerId));
const source = computed(() => {
  const p = profile.value;
  if (p && !p.avatar) return null;
  if (p?.avatar && !p.avatar.startsWith('https://gravatar.com/avatar/')) return p.avatar;
  return `/api/profiles/${encodeURIComponent(props.playerId)}/avatar?key=${encodeURIComponent(p?.avatar ?? '')}`;
});
const loaded = ref(false);
const failed = ref(false);
watch(source, () => { loaded.value = false; failed.value = false; });
</script>

<template>
  <img v-if="source && !failed" v-show="loaded" :key="source" :src="source"
    class="player-avatar" alt="" aria-hidden="true" referrerpolicy="no-referrer"
    @load="loaded = true" @error="failed = true" />
</template>

<style scoped>
.player-avatar { width: 1.65em; height: 1.65em; display: inline-block; object-fit: cover; border-radius: 50%; flex: none; vertical-align: middle; margin-inline-end: 0.35em; }
</style>
