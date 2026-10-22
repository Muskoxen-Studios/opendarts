<script setup lang="ts">
import { ref } from 'vue';
import Heatmap from './Heatmap.vue';
import { api, store, type AchievementView, type Heatmap as HeatmapData, type Profile } from '../store.ts';

const name = ref('');
const busy = ref(false);
const openProfile = ref<string | null>(null);
const achievements = ref<AchievementView[]>([]);
const stats = ref<Record<string, unknown> | null>(null);
/** Where this player's darts have landed, across every finished match. */
const heatmap = ref<HeatmapData | null>(null);

const PALETTE = [
  '#4f8ef7',
  '#d8453f',
  '#3f9d54',
  '#e0a458',
  '#a06cd5',
  '#41b8c4',
  '#e85d9a',
  '#f2c14e',
  '#5cc48a',
  '#ff7043',
  '#7986cb',
  '#26a69a',
];

function randomColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

const color = ref(randomColor());

async function add(): Promise<void> {
  if (!name.value.trim()) return;
  busy.value = true;
  try {
    await api.createProfile(name.value.trim(), color.value);
    name.value = '';
    color.value = randomColor();
    await api.loadProfiles();
  } finally {
    busy.value = false;
  }
}

/**
 * Delete a player.
 *
 * Confirmed by name: it cannot be walked back from the UI. The deletion is
 * soft on the server, so the matches they played stay on record -- the
 * confirmation says so rather than implying history is destroyed.
 */
async function remove(id: string): Promise<void> {
  const name = store.profiles.find((p) => p.id === id)?.name ?? 'this player';
  if (
    !confirm(
      `Delete ${name}? They disappear from the players list and the leaderboard. ` +
        `Matches already played stay on record.`,
    )
  ) {
    return;
  }
  await api.deleteProfile(id);
  if (openProfile.value === id) openProfile.value = null;
  await api.loadProfiles();
}

/** Remove an achievement, e.g. one a misdetected dart triggered. */
async function removeAchievement(profileId: string, achievementId: string): Promise<void> {
  await api.deleteAchievement(profileId, achievementId);
  achievements.value = await api.achievements(profileId);
}

// -- editing a player ------------------------------------------------------

const editing = ref<string | null>(null);
const draftName = ref('');
const draftColor = ref('');

function startEdit(p: Profile): void {
  editing.value = p.id;
  draftName.value = p.name;
  draftColor.value = p.color;
}

function cancelEdit(): void {
  editing.value = null;
}

async function saveEdit(id: string): Promise<void> {
  const name = draftName.value.trim();
  if (!name) return;
  await api.updateProfile(id, { name, color: draftColor.value });
  editing.value = null;
  await api.loadProfiles();
}

async function inspect(id: string): Promise<void> {
  if (openProfile.value === id) {
    openProfile.value = null;
    return;
  }
  openProfile.value = id;
  heatmap.value = null;
  [achievements.value, stats.value, heatmap.value] = await Promise.all([
    api.achievements(id),
    api.stats(id),
    api.heatmap(id),
  ]);
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

const HEADLINE: Array<[string, string]> = [
  ['matchesPlayed', 'Matches'],
  ['matchesWon', 'Won'],
  ['average3', '3-dart avg'],
  ['first9Average', 'First 9'],
  ['count180', '180s'],
  ['bestLegDarts', 'Best leg'],
  ['highestCheckout', 'High out'],
  ['mpr', 'MPR'],
  ['knockbacksDealt', 'Knock-backs'],
  ['golfHandicap', 'Golf hcp'],
  ['longestStreak', 'Best streak'],
];
</script>

<template>
  <section class="profiles">
    <div class="page-heading"><p class="page-eyebrow">The people behind the darts</p><h2>Players</h2><p class="page-description">Your crew, personal bests and achievements. Stored locally, without accounts.</p></div>

    <!--
      autocomplete="off" plus the vendor opt-outs below stop password managers
      treating a lone text input inside a form as a username field and popping
      their save/fill prompt over the UI.
    -->
    <form class="add" autocomplete="off" @submit.prevent="add">
      <input
        v-model="name"
        type="text"
        name="darts-player-label"
        placeholder="Add a player"
        maxlength="24"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="words"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
      />
      <div class="swatches">
        <button
          v-for="c in PALETTE"
          :key="c"
          type="button"
          class="swatch"
          :class="{ on: color === c }"
          :style="{ background: c }"
          :aria-label="`Colour ${c}`"
          @click="color = c"
        />
      </div>
      <button class="primary" type="submit" :disabled="busy || !name.trim()">Add</button>
    </form>

    <ul class="list">
      <li v-for="p in store.profiles" :key="p.id">
        <div v-if="editing === p.id" class="head editing">
          <input
            v-model="draftName"
            class="edit-name"
            maxlength="24"
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            @keyup.enter="saveEdit(p.id)"
            @keyup.escape="cancelEdit"
          />
          <div class="swatches">
            <button
              v-for="c in PALETTE"
              :key="c"
              type="button"
              class="swatch"
              :class="{ on: draftColor === c }"
              :style="{ background: c }"
              :aria-label="`Colour ${c}`"
              @click="draftColor = c"
            />
          </div>
          <button class="primary small" @click="saveEdit(p.id)">Save</button>
          <button class="ghost" @click="cancelEdit">Cancel</button>
        </div>

        <div v-else class="head">
          <span class="dot" :style="{ background: p.color }" />
          <button class="name" @click="inspect(p.id)">{{ p.name }}</button>
          <button class="edit" title="Rename or recolour" @click="startEdit(p)">&#9998;</button>
          <button class="del" title="Remove" @click="remove(p.id)">&times;</button>
        </div>

        <div v-if="openProfile === p.id" class="detail">
          <div class="stats">
            <div v-for="[key, label] in HEADLINE" :key="key" class="stat">
              <span class="label">{{ label }}</span>
              <span class="value">{{ fmt(stats?.[key]) }}</span>
            </div>
          </div>

          <h3>Where the darts land</h3>
          <div class="heat-wrap">
            <Heatmap
              v-if="heatmap && heatmap.total > 0"
              :heatmap="heatmap"
              :color="p.color"
            />
            <p v-else class="hint">
              Nothing to plot yet &mdash; the map is built from finished matches.
            </p>
          </div>

          <h3>Achievements</h3>
          <div class="achievements">
            <div
              v-for="a in achievements"
              :key="a.id"
              class="ach"
              :class="{ locked: !a.unlockedAt, [a.tier ?? 'none']: true }"
              :title="a.description"
            >
              <span class="icon">{{ a.icon }}</span>
              <span class="text">
                <b>{{ a.name }}</b>
                <small>{{ a.description }}</small>
                <span v-if="!a.unlockedAt && a.goal > 1" class="bar">
                  <i :style="{ width: `${Math.min(100, (a.progress / a.goal) * 100)}%` }" />
                  <em>{{ a.progress }}/{{ a.goal }}</em>
                </span>
              </span>

              <button
                v-if="a.unlockedAt"
                class="act"
                title="Remove this achievement. It can be earned again."
                @click="removeAchievement(p.id, a.id)"
              >&times;</button>
            </div>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.profiles { display: flex; flex-direction: column; gap: 0.85rem; }
h2 { margin: 0; font-size: 1.1rem; }
h3 { margin: 0.9rem 0 0.4rem; font-size: 0.85rem; color: var(--ui-muted); text-transform: uppercase; letter-spacing: 0.07em; }
.hint { margin: 0; font-size: 0.8rem; color: var(--ui-muted); }

.add { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
input {
  flex: 1 1 10rem; background: var(--ui-surface); border: 1px solid var(--ui-border);
  color: var(--ui-text); border-radius: 6px; padding: 0.5rem 0.7rem; font: inherit;
}
.swatches { display: flex; gap: 0.25rem; }
.swatch { width: 1.4rem; height: 1.4rem; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.swatch.on { border-color: var(--ui-text); }
.primary { background: var(--ui-accent); border: none; color: #fff; border-radius: 6px; padding: 0.5rem 1rem; cursor: pointer; font-weight: 600; }
.primary:disabled { opacity: 0.45; cursor: not-allowed; }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.head { display: flex; align-items: center; gap: 0.6rem; }
.dot { width: 0.8rem; height: 0.8rem; border-radius: 50%; flex: none; }
.name { flex: 1; text-align: left; background: none; border: none; color: var(--ui-text); font: inherit; font-weight: 600; cursor: pointer; padding: 0.3rem 0; }
.del, .edit { background: none; border: none; color: #6b7280; font-size: 1.1rem; cursor: pointer; padding: 0 0.2rem; }
.del:hover { color: var(--ui-danger); }
.edit:hover { color: var(--ui-accent); }

.head.editing { gap: 0.5rem; flex-wrap: wrap; }
.edit-name {
  flex: 1 1 8rem; background: var(--ui-surface-deep); border: 1px solid var(--ui-border);
  color: var(--ui-text); border-radius: 6px; padding: 0.35rem 0.55rem; font: inherit;
}
.primary.small { padding: 0.35rem 0.8rem; font-size: 0.85rem; }
.ghost {
  background: none; border: 1px solid var(--ui-border); color: var(--ui-muted);
  border-radius: 6px; padding: 0.35rem 0.8rem; cursor: pointer; font: inherit; font-size: 0.85rem;
}

.detail { border-left: 2px solid var(--ui-border); margin-left: 0.35rem; padding: 0.5rem 0 0.5rem 0.9rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr)); gap: 0.5rem; }
.stat { background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: 6px; padding: 0.4rem 0.6rem; }
.stat .label { display: block; font-size: 0.68rem; color: var(--ui-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.stat .value { font-size: 1.1rem; font-weight: 600; font-variant-numeric: tabular-nums; }

.heat-wrap { max-width: 22rem; }
.achievements { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 0.5rem; }
.ach { display: flex; gap: 0.6rem; align-items: flex-start; background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: 8px; padding: 0.5rem 0.65rem; }
.ach.locked { opacity: 0.42; }
.ach .act {
  margin-left: auto; background: none; border: none; color: #6b7280;
  font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 0 0.15rem; flex: none;
}
.ach .act:hover { color: var(--ui-danger); }
.ach .act:hover { color: var(--ui-danger); }
.ach.gold { border-color: #b8912f; }
.ach.silver { border-color: #7d8590; }
.ach.bronze { border-color: #7a5230; }
.icon { font-size: 1.3rem; }
.text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }
.text small { color: var(--ui-muted); font-size: 0.72rem; }
.bar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 1.05rem;
  background: var(--ui-border);
  border-radius: 999px;
  margin-top: 0.25rem;
  overflow: hidden;
}
.bar i { position: absolute; inset: 0 auto 0 0; background: var(--ui-accent); border-radius: 999px; }
.bar em {
  position: relative;
  font-style: normal;
  font-size: 0.66rem;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--ui-text);
  text-shadow: 0 1px 2px rgb(0 0 0 / 55%);
}

.profiles { max-width: 1200px; margin-inline: auto; gap: 1.2rem; }
.add { border: 1px solid var(--ui-border); border-radius: 16px; background: var(--ui-surface-deep); padding: 1rem; gap: 0.75rem; box-shadow: var(--ui-shadow); }
input { border-radius: 9px; padding: 0.7rem 0.8rem; }.primary { border-radius: 9px; color: #062337; padding: 0.7rem 1.2rem; font-weight: 750; background: linear-gradient(120deg, #71dcff, #40b9ef); }
.list { gap: 0.8rem; }.list > li { border: 1px solid var(--ui-border); border-radius: 16px; padding: 1rem; background: linear-gradient(125deg, #15344980, #0b1d2b); box-shadow: var(--ui-shadow); }
.head { min-height: 2.2rem; }.name { font-size: 1.1rem; }.dot { width: 1rem; height: 1rem; box-shadow: 0 0 0 4px #ffffff08; }
.swatch { width: 1.6rem; height: 1.6rem; }.edit, .del { padding: 0.4rem; color: var(--ui-muted); }
.detail { margin-top: 1rem; border-left-color: #365d73; padding-left: 1rem; }.stats { gap: 0.7rem; }.stat { border-radius: 10px; background: #0b2030; padding: 0.85rem; }.stat .label { line-height: 1.45; }.stat .value { display: block; margin-top: 0.3rem; color: var(--ui-accent); font-size: 1.6rem; }
.ach { border-radius: 12px; padding: 0.9rem; background: linear-gradient(135deg, #17354a, #0e2535); }.ach.locked { opacity: 0.65; }.ach.gold { background: linear-gradient(135deg, #4a3b2170, #102636); }.ach .icon { font-size: 1.8rem; }.text small { line-height: 1.5; }.bar { height: 1.2rem; background: var(--ui-surface-deep); }.bar i { background: linear-gradient(90deg, #188fbc, #56cfff); }.bar em { color: #fff; text-shadow: 0 1px 3px #000; }

</style>
