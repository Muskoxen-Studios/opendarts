<script setup lang="ts">
/**
 * The rules of one game, as an overlay over the setup screen.
 *
 * The text is a markdown file in `src/manuals/`; the HTML is produced by our own
 * small renderer, which escapes everything it reads -- see markdown.ts.
 */
import { computed } from 'vue';
import { manualFor } from '../manuals.ts';
import { renderMarkdown } from '../markdown.ts';

const props = defineProps<{ gameType: string; label: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const source = computed(() => manualFor(props.gameType));
const html = computed(() => (source.value ? renderMarkdown(source.value) : ''));
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" :aria-label="`${label} manual`" @click.self="emit('close')">
    <section class="sheet">
      <header>
        <h2>{{ label }}</h2>
        <button class="close" aria-label="Close" @click="emit('close')">&times;</button>
      </header>

      <!-- eslint-disable-next-line vue/no-v-html -- rendered by markdown.ts, which escapes its input -->
      <article v-if="html" class="doc" v-html="html" />
      <p v-else class="empty">
        There is no manual for {{ label }} yet. Add one as
        <code>packages/frontend/src/manuals/{{ gameType }}.md</code> and it shows
        up here.
      </p>

      <footer>
        <button class="ghost" @click="emit('close')">Close</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; z-index: 30;
  background: rgb(6 8 11 / 78%);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 1.5rem 1rem; overflow: auto;
}
.sheet {
  width: min(760px, 100%);
  background: #0f1216; border: 1px solid #262b33; border-radius: 14px;
  padding: 1.1rem 1.25rem 1rem;
  display: flex; flex-direction: column; gap: 0.75rem;
  box-shadow: 0 24px 60px rgb(0 0 0 / 55%);
}
header { display: flex; align-items: center; gap: 1rem; }
h2 { margin: 0; font-size: 1.25rem; }
.close { margin-left: auto; background: none; border: none; color: #6b7280; font-size: 1.6rem; line-height: 1; cursor: pointer; }
.close:hover { color: #e8e6e1; }
.empty { margin: 0; font-size: 0.9rem; color: #8b93a1; }
footer { display: flex; justify-content: flex-end; }
.ghost {
  background: none; border: 1px solid #333b49; color: #cdd3dc;
  border-radius: 999px; padding: 0.35rem 1rem; cursor: pointer; font: inherit; font-size: 0.85rem;
}
.ghost:hover { border-color: #4f8ef7; color: #fff; }

/* The rendered document. Deep, because the HTML arrives through v-html. */
.doc { max-height: 68vh; overflow-y: auto; padding-right: 0.35rem; font-size: 0.92rem; line-height: 1.6; }
.doc :deep(h1) { font-size: 1.05rem; margin: 0 0 0.6rem; }
.doc :deep(h2) {
  font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: #8b93a1; margin: 1.3rem 0 0.4rem;
}
.doc :deep(h3) { font-size: 0.9rem; margin: 1rem 0 0.3rem; }
.doc :deep(p) { margin: 0.5rem 0; color: #cdd3dc; }
.doc :deep(ul), .doc :deep(ol) { margin: 0.5rem 0; padding-left: 1.2rem; color: #cdd3dc; }
.doc :deep(li) { margin: 0.2rem 0; }
.doc :deep(strong) { color: #fff; }
.doc :deep(code) {
  background: #14171c; border: 1px solid #262b33; border-radius: 4px;
  padding: 0 0.25rem; font-size: 0.85em;
}
.doc :deep(pre) {
  background: #14171c; border: 1px solid #262b33; border-radius: 8px;
  padding: 0.6rem 0.75rem; overflow-x: auto;
}
.doc :deep(pre code) { background: none; border: none; padding: 0; }
.doc :deep(hr) { border: none; border-top: 1px solid #262b33; margin: 1rem 0; }
.doc :deep(blockquote) {
  margin: 0.6rem 0; padding: 0.1rem 0 0.1rem 0.75rem;
  border-left: 2px solid #333b49; color: #8b93a1;
}
.doc :deep(table) { width: 100%; border-collapse: collapse; margin: 0.6rem 0; font-size: 0.88rem; }
.doc :deep(th), .doc :deep(td) { text-align: left; padding: 0.35rem 0.5rem; }
.doc :deep(thead th) {
  font-size: 0.68rem; color: #8b93a1; text-transform: uppercase;
  letter-spacing: 0.05em; font-weight: 600;
}
.doc :deep(tbody tr) { border-top: 1px solid #1d222a; }
</style>
