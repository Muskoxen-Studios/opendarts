<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Heatmap from './Heatmap.vue';
import {
  api,
  pushToast,
  type ArchivedRow,
  type Leaderboard,
  type LeaderboardArchive,
  type LeaderboardArchiveSummary,
  type LeaderboardRow,
} from '../store.ts';

/**
 * Every player, ranked.
 *
 * The table covers the current season -- the window since the last reset --
 * because that is the only thing a reset changes. No match is ever deleted, so
 * a player's own profile page still shows their whole career.
 */
const board = ref<Leaderboard | null>(null);
const archives = ref<LeaderboardArchiveSummary[]>([]);
const openArchive = ref<LeaderboardArchive | null>(null);
const expanded = ref<string | null>(null);
const loading = ref(true);
const resetting = ref(false);

type SortKey = keyof Pick<
  LeaderboardRow,
  | 'points'
  | 'matchesPlayed'
  | 'matchesWon'
  | 'winRate'
  | 'average3'
  | 'first9Average'
  | 'bestTurn'
  | 'count180'
  | 'checkoutsHit'
  | 'bustedTurns'
  | 'golfBestPoints'
>;

/** Columns, in the order they appear. `null` sorts last whichever way. */
const COLUMNS: Array<{ key: SortKey; label: string; title: string; format: (r: LeaderboardRow) => string }> = [
  { key: 'points', label: 'Pts', title: '3 for a win, 1 for playing', format: (r) => String(r.points) },
  { key: 'matchesPlayed', label: 'P', title: 'Matches played', format: (r) => String(r.matchesPlayed) },
  { key: 'matchesWon', label: 'W', title: 'Matches won', format: (r) => String(r.matchesWon) },
  { key: 'winRate', label: 'Win %', title: 'Win rate', format: (r) => pct(r.winRate) },
  { key: 'average3', label: 'Avg', title: 'Three-dart average (X01)', format: (r) => num(r.average3) },
  { key: 'first9Average', label: 'First 9', title: 'First-nine average (X01)', format: (r) => num(r.first9Average) },
  { key: 'bestTurn', label: 'Best', title: 'Highest turn', format: (r) => int(r.bestTurn) },
  { key: 'count180', label: '180s', title: 'Maximums', format: (r) => String(r.count180) },
  {
    key: 'checkoutsHit',
    label: 'Outs',
    title: 'Checkouts hit, and the rate at which they were taken',
    format: (r) => (r.checkoutRate === null ? String(r.checkoutsHit) : `${r.checkoutsHit} (${pct(r.checkoutRate)})`),
  },
  { key: 'bustedTurns', label: 'Busts', title: 'Turns that busted', format: (r) => String(r.bustedTurns) },
  { key: 'golfBestPoints', label: 'Golf', title: 'Best Stableford round', format: (r) => int(r.golfBestPoints) },
];

const sortKey = ref<SortKey | null>(null);

const rows = computed<LeaderboardRow[]>(() => {
  const list = [...(board.value?.rows ?? [])];
  const key = sortKey.value;
  // No explicit sort means the server's ranking, which is the honest default:
  // it is what the rank numbers refer to.
  if (!key) return list;
  return list.sort((a, b) => value(b, key) - value(a, key) || a.rank - b.rank);
});

function value(row: LeaderboardRow, key: SortKey): number {
  const v = row[key];
  return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
}

function sortBy(key: SortKey): void {
  sortKey.value = sortKey.value === key ? null : key;
}

function num(v: number | null): string {
  return v === null ? '–' : v.toFixed(2);
}
function int(v: number | null): string {
  return v === null ? '–' : String(v);
}
function pct(v: number | null): string {
  return v === null ? '–' : `${Math.round(v * 100)}%`;
}
function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '–';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    [board.value, archives.value] = await Promise.all([
      api.leaderboard(),
      api.leaderboardArchives(),
    ]);
  } catch (err) {
    pushToast('Could not load the leaderboard', (err as Error).message, '\u{26A0}');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function toggle(playerId: string): void {
  expanded.value = expanded.value === playerId ? null : playerId;
}

/**
 * Archive the table and start again from zero.
 *
 * Confirmed first, then named: the confirmation is the decision, the prompt
 * that follows is only the season's label. Worth being precise about in both:
 * this deletes nothing. It files the standings away and moves the date the
 * table counts from, so career stats, achievements and every match report are
 * untouched.
 */
async function reset(): Promise<void> {
  if (
    !confirm(
      'Reset the leaderboard? The current standings are archived and the table ' +
        'starts from zero. Nothing is deleted — every match stays on record.',
    )
  ) {
    return;
  }
  const label = prompt('Name the season being archived (optional):', '');
  if (label === null) return;
  resetting.value = true;
  try {
    const archive = await api.resetLeaderboard(label.trim() || undefined);
    pushToast('Leaderboard archived', `${archive.label} — ${archive.matches} matches`, '\u{1F5C3}');
    expanded.value = null;
    await load();
  } catch (err) {
    pushToast('Could not reset the leaderboard', (err as Error).message, '\u{26A0}');
  } finally {
    resetting.value = false;
  }
}

async function view(id: string): Promise<void> {
  if (openArchive.value?.id === id) {
    openArchive.value = null;
    return;
  }
  try {
    openArchive.value = await api.leaderboardArchive(id);
  } catch (err) {
    pushToast('Could not open that archive', (err as Error).message, '\u{26A0}');
  }
}

async function discard(id: string, label: string): Promise<void> {
  if (!confirm(`Delete the archived leaderboard "${label}"? The matches behind it stay on record.`)) {
    return;
  }
  await api.deleteLeaderboardArchive(id);
  if (openArchive.value?.id === id) openArchive.value = null;
  archives.value = await api.leaderboardArchives();
}

/** Archived rows carry a narrower set of figures than live ones. */
const ARCHIVE_COLUMNS: Array<{ label: string; format: (r: ArchivedRow) => string }> = [
  { label: 'Pts', format: (r) => String(r.points) },
  { label: 'P', format: (r) => String(r.matchesPlayed) },
  { label: 'W', format: (r) => String(r.matchesWon) },
  { label: 'Win %', format: (r) => pct(r.winRate) },
  { label: 'Avg', format: (r) => num(r.average3) },
  { label: 'First 9', format: (r) => num(r.first9Average) },
  { label: 'Best', format: (r) => int(r.bestTurn) },
  { label: '180s', format: (r) => String(r.count180) },
  { label: 'Outs', format: (r) => String(r.checkoutsHit) },
  { label: 'Busts', format: (r) => String(r.bustedTurns) },
  { label: 'Golf', format: (r) => int(r.golfBestPoints) },
];
</script>

<template>
  <section class="leaderboard">
    <header>
      <h2>Leaderboard</h2>
      <p v-if="board" class="hint">
        {{ board.matchesCounted }} finished
        {{ board.matchesCounted === 1 ? 'match' : 'matches' }}
        <template v-if="board.since"> since {{ day(board.since) }}</template>
        <template v-else> — everything on record</template>.
        Ranked on points: 3 for a win, 1 for turning up.
      </p>
      <button class="ghost" :disabled="resetting || !board || board.rows.length === 0" @click="reset">
        {{ resetting ? 'Archiving…' : 'Reset leaderboard' }}
      </button>
    </header>

    <p v-if="loading" class="hint">Loading…</p>

    <p v-else-if="!board || board.rows.length === 0" class="empty">
      Nothing here yet. Finish a match and the table fills itself in.
    </p>

    <table v-else class="table">
      <thead>
        <tr>
          <th class="rank">#</th>
          <th class="who">Player</th>
          <th
            v-for="c in COLUMNS"
            :key="c.key"
            :title="c.title"
            :class="{ sorted: sortKey === c.key }"
            @click="sortBy(c.key)"
          >{{ c.label }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.playerId">
          <tr class="row" :class="{ open: expanded === row.playerId }" @click="toggle(row.playerId)">
            <td class="rank">{{ row.rank }}</td>
            <td class="who">
              <span class="dot" :style="{ background: row.color }" />
              {{ row.name }}
            </td>
            <td v-for="c in COLUMNS" :key="c.key" :class="{ sorted: sortKey === c.key }">
              {{ c.format(row) }}
            </td>
          </tr>

          <tr v-if="expanded === row.playerId" :key="`${row.playerId}-detail`" class="detail">
            <td :colspan="COLUMNS.length + 2">
              <div class="detail-grid">
                <div class="heat">
                  <h3>Where the darts land</h3>
                  <Heatmap v-if="row.heatmap.total > 0" :heatmap="row.heatmap" :color="row.color" />
                  <p v-else class="hint">No darts on record this season.</p>
                </div>

                <div class="facts">
                  <h3>Season</h3>
                  <dl>
                    <dt>Darts thrown</dt><dd>{{ row.dartsThrown }}</dd>
                    <dt>Legs won</dt><dd>{{ row.legsWon }}</dd>
                    <dt>140+ / 100+</dt><dd>{{ row.count140plus }} / {{ row.count100plus }}</dd>
                    <dt>Highest checkout</dt><dd>{{ row.highestCheckout || '–' }}</dd>
                    <dt>Best leg</dt><dd>{{ int(row.bestLegDarts) }} darts</dd>
                    <dt>MPR (cricket)</dt><dd>{{ num(row.mpr) }}</dd>
                    <dt>Streak</dt><dd>{{ row.currentStreak }} now, {{ row.longestStreak }} best</dd>
                    <dt>Golf handicap</dt><dd>{{ row.golfHandicap }}</dd>
                    <dt>Last played</dt><dd>{{ day(row.lastPlayed) }}</dd>
                  </dl>
                </div>

                <div v-if="row.golfBestCard" class="card">
                  <h3>Best golf card &mdash; {{ row.golfBestPoints }} points</h3>
                  <table class="holes">
                    <tr class="h">
                      <th>Hole</th>
                      <th v-for="h in row.golfBestCard" :key="h.hole">{{ h.hole }}</th>
                    </tr>
                    <tr>
                      <th>Par</th>
                      <td v-for="h in row.golfBestCard" :key="h.hole">{{ h.par }}</td>
                    </tr>
                    <tr>
                      <th>Strokes</th>
                      <td v-for="h in row.golfBestCard" :key="h.hole" :class="{ miss: !h.holed }">
                        {{ h.strokes }}
                      </td>
                    </tr>
                    <tr>
                      <th>Points</th>
                      <td v-for="h in row.golfBestCard" :key="h.hole" :class="{ zero: h.points === 0 }">
                        {{ h.points }}
                      </td>
                    </tr>
                  </table>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-if="archives.length" class="archived">
      <h3>Past leaderboards</h3>
      <p class="hint">
        A reset files the standings here and starts a new season. Only the
        summary is kept &mdash; the matches themselves are still on record, so
        anything else can be rebuilt from them.
      </p>
      <ul>
        <li v-for="a in archives" :key="a.id">
          <button class="label" @click="view(a.id)">{{ a.label }}</button>
          <span class="meta">{{ a.matches }} matches · filed {{ day(a.createdAt) }}</span>
          <button class="del" title="Delete this archive" @click="discard(a.id, a.label)">&times;</button>
        </li>
      </ul>

      <table v-if="openArchive" class="table archive-table">
        <caption>{{ openArchive.label }}</caption>
        <thead>
          <tr>
            <th class="rank">#</th>
            <th class="who">Player</th>
            <th v-for="c in ARCHIVE_COLUMNS" :key="c.label">{{ c.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in openArchive.rows" :key="r.playerId">
            <td class="rank">{{ r.rank }}</td>
            <td class="who">
              <span class="dot" :style="{ background: r.color }" />
              {{ r.name }}
            </td>
            <td v-for="c in ARCHIVE_COLUMNS" :key="c.label">{{ c.format(r) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.leaderboard { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
h2 { margin: 0; font-size: 1.1rem; }
h3 { margin: 0 0 0.4rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: #8b93a1; }
.hint { margin: 0; font-size: 0.8rem; color: #8b93a1; line-height: 1.45; flex: 1 1 16rem; }
.empty { color: #8b93a1; text-align: center; padding: 3rem 1rem; }
.ghost {
  background: none; border: 1px solid #45262a; color: #c9645f;
  border-radius: 8px; padding: 0.45rem 0.9rem; cursor: pointer; font: inherit; font-size: 0.85rem;
}
.ghost:hover:not(:disabled) { border-color: #d8453f; color: #d8453f; }
.ghost:disabled { opacity: 0.4; cursor: not-allowed; }

.table { width: 100%; border-collapse: collapse; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
.table th, .table td { padding: 0.4rem 0.5rem; text-align: right; border-bottom: 1px solid #1d2128; }
.table th { color: #8b93a1; font-weight: 500; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; white-space: nowrap; }
.table th:hover { color: #cdd3dc; }
.table th.sorted, .table td.sorted { color: #4f8ef7; }
.table .rank, .table .who { text-align: left; }
.table .who { white-space: nowrap; }
.table th.rank, .table th.who { cursor: default; }
.dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.4rem; }
.row { cursor: pointer; }
.row:hover td { background: #14171c; }
.row.open td { background: #171b22; }
.detail td { background: #0f1216; }
.detail-grid { display: grid; grid-template-columns: minmax(0, 18rem) minmax(0, 1fr); gap: 1.25rem; padding: 0.75rem 0.25rem; text-align: left; }
@media (max-width: 760px) { .detail-grid { grid-template-columns: 1fr; } }
.card { grid-column: 1 / -1; }
.facts dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; margin: 0; font-size: 0.82rem; }
.facts dt { color: #8b93a1; }
.facts dd { margin: 0; }
.holes { border-collapse: collapse; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.holes th, .holes td { border: 1px solid #1d2128; padding: 0.2rem 0.4rem; text-align: center; min-width: 1.6rem; }
.holes th { color: #8b93a1; font-weight: 500; }
.holes td.miss { color: #c9645f; }
.holes td.zero { color: #6b7280; }

.archived { border-top: 1px solid #1d2128; padding-top: 0.9rem; }
.archived ul { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.archived li { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
.archived .label { background: none; border: none; color: #e8e6e1; font: inherit; font-weight: 600; cursor: pointer; padding: 0.2rem 0; text-align: left; }
.archived .label:hover { color: #4f8ef7; }
.archived .meta { color: #8b93a1; font-size: 0.78rem; flex: 1; }
.archived .del { background: none; border: none; color: #6b7280; font-size: 1.1rem; cursor: pointer; padding: 0 0.2rem; }
.archived .del:hover { color: #d8453f; }
.archive-table { margin-top: 0.8rem; }
.archive-table caption { text-align: left; color: #8b93a1; font-size: 0.78rem; padding-bottom: 0.35rem; }
.archive-table th { cursor: default; }
</style>
