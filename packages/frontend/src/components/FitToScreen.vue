<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const viewport = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const scale = ref(1);
let observer: ResizeObserver | undefined;
let frame = 0;

function fit(): void {
  const outer = viewport.value;
  const inner = content.value;
  if (!outer || !inner) return;
  // Layout sizes are unscaled: measuring transformed bounds would cause the
  // next observer pass to enlarge the content again and oscillate.
  const width = Math.max(inner.offsetWidth, inner.scrollWidth);
  const height = Math.max(inner.offsetHeight, inner.scrollHeight);
  if (width && height) {
    scale.value = Math.min(1, outer.clientWidth / width, outer.clientHeight / height);
  }
}

function scheduleFit(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(fit);
}

onMounted(() => {
  observer = new ResizeObserver(scheduleFit);
  if (viewport.value) observer.observe(viewport.value);
  if (content.value) observer.observe(content.value);
  document.fonts.ready.then(scheduleFit);
  fit();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="viewport" class="fit-viewport">
    <div ref="content" class="fit-content" :style="{ transform: `scale(${scale})` }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.fit-viewport { position: relative; width: 100%; height: 100%; overflow: hidden; }
.fit-content { width: 100%; transform-origin: top center; display: flow-root; }
</style>
