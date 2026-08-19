import { reactive, readonly } from 'vue';
import type { MatchView, Segment } from '@darts/schema';

export interface Profile {
  id: string;
  name: string;
  color: string;
  avatar: string | null;
  createdAt: string;
}

export interface AchievementView {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: string | null;
  requiresCoords: boolean;
  unlockedAt: string | null;
  progress: number;
  goal: number;
}

/**
 * Statistics types mirrored from @darts/stats.
 *
 * Deliberately re-declared rather than imported: the frontend depends on
 * @darts/schema and nothing else, and importing the stats package would pull
 * the whole engine into the browser bundle to gain a type.
 */
export interface HeatCell {
  number: number;
  ring: string;
  count: number;
}

export interface Heatmap {
  total: number;
  cells: HeatCell[];
  max: number;
  byNumber: Record<number, number>;
  maxByNumber: number;
  dots: Array<{ x: number; y: number; playerId: string }>;
  /** How many of the throws carried coordinates. */
  withCoords: number;
}

export interface GolfHoleResult {
  hole: number;
  par: number;
  strokes: number;
  points: number;
  holed: boolean;
}

export interface GolfHandicap {
  handicap: number;
  rounds: number;
  counted: number;
  recent: Array<{
    matchId: string;
    endedAt: string | null;
    handicap: number;
    points: number;
    holesPlayed: number;
    playedTo: number;
  }>;
}

export interface PlayerReport {
  playerId: string;
  name: string;
  color: string;
  darts: number;
  score: number;
  legsWon: number;
  average3: number | null;
  first9Average: number | null;
  bestTurn: number | null;
  count180: number;
  count140plus: number;
  count100plus: number;
  bustedTurns: number;
  checkouts: Array<{ startScore: number; darts: number; finisher: string; from: number }>;
  highestCheckout: number;
  mpr: number | null;
  golf: {
    handicap: number;
    points: number;
    holes: GolfHoleResult[];
    holed: number;
    birdiesOrBetter: number;
  } | null;
  heatmap: Heatmap;
}

export interface MatchReport {
  matchId: string;
  gameType: string;
  winnerId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  conceded: boolean;
  legsPlayed: number;
  totalDarts: number;
  players: PlayerReport[];
  heatmap: Heatmap;
  winningTurn: {
    playerId: string;
    name: string;
    color: string;
    darts: Array<{ label: string; value: number; counted: number; coords: { x: number; y: number } | null }>;
  } | null;
}

export interface MatchSetupRecord {
  gameType: string;
  config: Record<string, unknown>;
  playerIds: string[];
}

export type SourceConfig =
  | { kind: 'simulator' }
  | { kind: 'autodarts'; url: string; debugMotion?: boolean }
  | { kind: 'replay'; file: string; speed?: number; loop?: boolean };

export interface BridgeStatus {
  config: SourceConfig;
  description: string;
  acceptsInjection: boolean;
  stored?: SourceConfig | null;
}

export interface Settings {
  coordsEnabled: boolean;
  celebrations: boolean;
  celebrationSeconds: number;
  /** Null when the bridge cannot be reached. */
  bridge: BridgeStatus | null;
  runtime: {
    bridgeWs: string;
    dbFile: string;
    boardOnline: boolean;
  };
}

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

export interface Toast {
  id: number;
  title: string;
  body: string;
  icon: string;
}

interface State {
  view: MatchView | null;
  profiles: Profile[];
  boardOnline: boolean;
  connected: boolean;
  toasts: Toast[];
  lastError: string | null;
  /** Front of the celebration queue; the rest wait their turn. */
  celebration: Celebration | null;
  celebrationQueue: Celebration[];
  celebrationsEnabled: boolean;
  celebrationSeconds: number;
}

const state = reactive<State>({
  view: null,
  profiles: [],
  boardOnline: false,
  connected: false,
  toasts: [],
  lastError: null,
  celebration: null,
  celebrationQueue: [],
  celebrationsEnabled: true,
  celebrationSeconds: 6,
});

let toastId = 0;
let celebrationKey = 0;
let celebrationTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Celebrations are queued rather than stacked. A nine-darter can unlock several
 * at once, and showing them on top of each other would mean seeing none of them.
 */
function enqueueCelebration(c: Omit<Celebration, 'key'>): void {
  const entry: Celebration = { ...c, key: celebrationKey++ };
  if (state.celebration === null) showCelebration(entry);
  else state.celebrationQueue.push(entry);
}

function showCelebration(c: Celebration): void {
  state.celebration = c;
  if (celebrationTimer) clearTimeout(celebrationTimer);
  celebrationTimer = setTimeout(dismissCelebration, state.celebrationSeconds * 1000);
}

/**
 * Drop a celebration for an achievement that has just been withdrawn.
 *
 * Undoing a dart immediately after it unlocked something is a normal
 * correction, and leaving the celebration on screen would be actively
 * misleading -- so pull it, whether it is showing or still queued.
 */
function retractCelebration(achievementIds: string[]): void {
  const ids = new Set(achievementIds);
  for (let i = state.celebrationQueue.length - 1; i >= 0; i--) {
    if (ids.has(state.celebrationQueue[i]!.id)) state.celebrationQueue.splice(i, 1);
  }
  if (state.celebration && ids.has(state.celebration.id)) dismissCelebration();
}

export function dismissCelebration(): void {
  if (celebrationTimer) clearTimeout(celebrationTimer);
  celebrationTimer = null;
  const next = state.celebrationQueue.shift();
  if (next) showCelebration(next);
  else state.celebration = null;
}

export function pushToast(title: string, body: string, icon = '\u{1F3AF}'): void {
  const toast: Toast = { id: toastId++, title, body, icon };
  state.toasts.push(toast);
  setTimeout(() => {
    const i = state.toasts.findIndex((t) => t.id === toast.id);
    if (i >= 0) state.toasts.splice(i, 1);
  }, 6000);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    state.lastError = (body as { error?: string }).error ?? res.statusText;
    throw new Error(state.lastError);
  }
  state.lastError = null;
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  async loadProfiles(): Promise<void> {
    state.profiles = await request<Profile[]>('/api/profiles');
  },
  createProfile(name: string, color: string): Promise<Profile> {
    return request<Profile>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    });
  },
  updateProfile(id: string, patch: { name?: string; color?: string }): Promise<Profile> {
    return request<Profile>(`/api/profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  deleteProfile(id: string): Promise<void> {
    return request<void>(`/api/profiles/${id}`, { method: 'DELETE' });
  },
  achievements(profileId: string): Promise<AchievementView[]> {
    return request<AchievementView[]>(`/api/profiles/${profileId}/achievements`);
  },
  stats(profileId: string): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(`/api/profiles/${profileId}/stats`);
  },
  startMatch(config: unknown, playerIds: string[]): Promise<MatchView> {
    return request<MatchView>('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ config, playerIds }),
    });
  },
  command(command: unknown): Promise<MatchView> {
    return request<MatchView>('/api/match/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  },
  /**
   * Virtual dartboard input; travels through the bridge like a real dart.
   *
   * Coordinates are optional and only the virtual board has them. Real darts
   * still arrive without, so nothing may depend on their presence.
   */
  simulate(segment: Segment, coords?: { x: number; y: number } | null): Promise<unknown> {
    return request('/api/simulate', {
      method: 'POST',
      body: JSON.stringify({ segment, coords: coords ?? null }),
    });
  },

  // -- history --------------------------------------------------------------

  /** Everything the post-match overview shows. `last` is a valid match id. */
  matchReport(matchId: string): Promise<MatchReport> {
    return request<MatchReport>(`/api/matches/${matchId}/report`);
  },
  /** The config and roster of a past match, so it can be set up again. */
  matchSetup(matchId: string): Promise<MatchSetupRecord> {
    return request<MatchSetupRecord>(`/api/matches/${matchId}/setup`);
  },
  heatmap(profileId: string): Promise<Heatmap> {
    return request<Heatmap>(`/api/profiles/${profileId}/heatmap`);
  },
  handicap(profileId: string): Promise<GolfHandicap> {
    return request<GolfHandicap>(`/api/profiles/${profileId}/handicap`);
  },

  // -- roster changes during a match ---------------------------------------
  addPlayerToMatch(profileId: string): Promise<MatchView> {
    return request<MatchView>('/api/match/players', {
      method: 'POST',
      body: JSON.stringify({ profileId }),
    });
  },
  removePlayerFromMatch(profileId: string): Promise<MatchView> {
    return request<MatchView>(`/api/match/players/${profileId}`, { method: 'DELETE' });
  },

  /** Remove an achievement. It can be earned again; the log is what decides. */
  deleteAchievement(profileId: string, achievementId: string): Promise<unknown> {
    return request(`/api/profiles/${profileId}/achievements/${achievementId}`, {
      method: 'DELETE',
    });
  },

  // -- settings -------------------------------------------------------------
  async settings(): Promise<Settings> {
    const s = await request<Settings>('/api/settings');
    state.celebrationsEnabled = s.celebrations;
    state.celebrationSeconds = s.celebrationSeconds;
    return s;
  },
  saveSettings(patch: Partial<Settings>): Promise<unknown> {
    return request('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  },
  recompute(): Promise<{ matches: number; profiles: number; unlocked: number }> {
    return request('/api/recompute', { method: 'POST' });
  },

  // -- bridge source --------------------------------------------------------
  bridgeSource(): Promise<BridgeStatus> {
    return request<BridgeStatus>('/api/bridge/source');
  },
  setBridgeSource(config: SourceConfig): Promise<{ ok: boolean }> {
    return request('/api/bridge/source', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
  },
  testBoard(url: string): Promise<{ ok: boolean; version?: string | null; latencyMs?: number; error?: string }> {
    return request('/api/bridge/test', { method: 'POST', body: JSON.stringify({ url }) });
  },
};

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    state.connected = true;
  };

  ws.onclose = () => {
    state.connected = false;
    setTimeout(connect, 1500);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    switch (msg.type) {
      case 'view':
        state.view = msg.view;
        break;
      case 'board':
        if (msg.event?.type === 'board.connected' || msg.event?.type === 'board.heartbeat') {
          state.boardOnline = true;
        }
        if (msg.event?.type === 'board.disconnected') state.boardOnline = false;
        break;
      case 'achievements.unlocked': {
        const color =
          state.view?.players.find((p) => p.playerId === msg.playerId)?.color ?? '#4f8ef7';
        for (const a of msg.achievements ?? []) {
          if (state.celebrationsEnabled) {
            enqueueCelebration({
              playerName: msg.playerName,
              playerColor: color,
              id: a.id,
              name: a.name,
              description: a.description,
              icon: a.icon,
              tier: a.tier ?? null,
            });
          } else {
            pushToast(`${a.icon} ${a.name}`, `${msg.playerName} — ${a.description}`, '\u{1F3C6}');
          }
        }
        break;
      }
      case 'achievements.withdrawn': {
        const ids = (msg.achievementIds ?? []) as string[];
        retractCelebration(ids);
        for (const id of ids) {
          pushToast('Achievement withdrawn', `${msg.playerName}: ${id} — the throw was undone`, '\u{21A9}');
        }
        break;
      }
      case 'domain':
        for (const e of msg.events ?? []) announce(e);
        break;
      default:
        break;
    }
  };
}

function announce(event: { type: string; [k: string]: unknown }): void {
  if (event.type === 'player.busted') pushToast('Bust', String(event.reason ?? ''), '\u{1F4A5}');
  if (event.type === 'gotcha.knockback') pushToast('Gotcha!', 'Knocked back', '\u{1F4A5}');
  if (event.type === 'leg.won') pushToast('Leg won', `in ${event.darts} darts`, '\u{1F3AF}');
}

export const store = readonly(state);
export const mutableState = state;
