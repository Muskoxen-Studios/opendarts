import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CoordsSchema, GameConfigSchema, MatchCommandSchema, SegmentSchema } from '@darts/schema';
import { CATALOGUE } from '@darts/stats';
import { connectToBridge } from './bridgeClient.ts';
import { openDatabase } from './db.ts';
import { MatchManager, type ServerEvent } from './matchManager.ts';
import { Store } from './store.ts';

const PORT = Number(process.env.PORT ?? 8080);
const DB_FILE = process.env.DB_FILE ?? 'data/darts.db';
const BRIDGE_WS = process.env.BRIDGE_WS ?? 'ws://localhost:8081/events';
const BRIDGE_HTTP = process.env.BRIDGE_HTTP ?? 'http://localhost:8081';

const db = openDatabase(DB_FILE);
const store = new Store(db);

const clients = new Set<WebSocket>();
function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
}

const manager = new MatchManager(store, broadcast);

// Resume an interrupted match so a restart mid-leg does not lose the game.
const unfinished = store.findUnfinishedMatch();
if (unfinished) {
  const resumed = manager.resume(unfinished);
  if (resumed) console.log(`[server] resumed match ${unfinished} from its command log`);
}

// -- tiny router -------------------------------------------------------------

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: unknown,
) => void | Promise<void>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:[a-zA-Z]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, pattern, keys, handler });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

// -- profiles ---------------------------------------------------------------

route('GET', '/api/profiles', (_req, res) => json(res, 200, store.listProfiles()));

route('POST', '/api/profiles', (_req, res, _p, body) => {
  const b = body as { name?: unknown; color?: unknown; avatar?: unknown };
  if (typeof b?.name !== 'string' || b.name.trim() === '') {
    return json(res, 400, { error: 'name is required' });
  }
  const profile = store.createProfile(
    b.name.trim(),
    typeof b.color === 'string' ? b.color : undefined,
    typeof b.avatar === 'string' ? b.avatar : null,
  );
  json(res, 201, profile);
});

route('PATCH', '/api/profiles/:id', (_req, res, params, body) => {
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'color', 'avatar']) if (k in b) patch[k] = b[k];
  const updated = store.updateProfile(params.id ?? '', patch);
  updated ? json(res, 200, updated) : json(res, 404, { error: 'not found' });
});

route('DELETE', '/api/profiles/:id', (_req, res, params) => {
  const ok = store.deleteProfile(params.id ?? '');
  json(res, ok ? 204 : 404, ok ? {} : { error: 'not found' });
});

route('GET', '/api/profiles/:id/stats', (_req, res, params) =>
  json(res, 200, store.careerFor(params.id ?? '')),
);

/**
 * Where this player's darts have landed, across every finished match.
 *
 * Always answerable: the segment counts come from scoring alone. The `dots`
 * array is only populated for throws whose source reported coordinates, so the
 * map degrades to segment density rather than disappearing.
 */
route('GET', '/api/profiles/:id/heatmap', (_req, res, params) =>
  json(res, 200, store.heatmapFor(params.id ?? '')),
);

/** The Stableford handicap this player would carry into their next golf round. */
route('GET', '/api/profiles/:id/handicap', (_req, res, params) =>
  json(res, 200, store.golfHandicapFor(params.id ?? '')),
);

route('GET', '/api/profiles/:id/achievements', (_req, res, params) => {
  const rows = new Map(store.readAchievements(params.id ?? '').map((a) => [a.achievementId, a]));
  const coordsEnabled = store.getSetting('coordsEnabled', false);
  json(
    res,
    200,
    CATALOGUE.filter((a) => coordsEnabled || !a.requiresCoords).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      tier: a.tier ?? null,
      requiresCoords: a.requiresCoords ?? false,
      unlockedAt: rows.get(a.id)?.unlockedAt ?? null,
      progress: rows.get(a.id)?.progress ?? 0,
      // Fall back to the catalogue's own target so a player who has never
      // thrown a dart still sees "0 / 10" rather than "0 / 1".
      goal: rows.get(a.id)?.goal ?? a.goal ?? 1,
    })),
  );
});

/**
 * Delete an achievement, e.g. when a misdetected dart triggered it.
 *
 * There is no "stays deleted" flag. Achievements are derived from the command
 * log, so if it is still earned it will simply be awarded again -- correcting
 * the misdetected throw is what makes the removal stick.
 */
route('DELETE', '/api/profiles/:id/achievements/:achievementId', (_req, res, params) => {
  const profileId = params.id ?? '';
  const achievementId = params.achievementId ?? '';
  store.deleteAchievement(profileId, achievementId);
  // Allow it to be re-awarded and celebrated again in the current match.
  manager.forgetAnnounced(profileId, achievementId);
  json(res, 200, { ok: true });
});

// -- matches ----------------------------------------------------------------

route('GET', '/api/matches', (_req, res) => json(res, 200, store.listMatches()));

/**
 * `last` is accepted wherever a match id is, and resolves to the most recently
 * finished match. That is what the scoreboard's "Last game" button asks for,
 * and it saves the client a round trip just to learn an id.
 */
function resolveMatchId(id: string): string | null {
  return id === 'last' ? store.lastFinishedMatchId() : id;
}

route('GET', '/api/matches/:id/report', (_req, res, params) => {
  const id = resolveMatchId(params.id ?? '');
  const report = id ? store.summaryFor(id) : null;
  report ? json(res, 200, report) : json(res, 404, { error: 'no such match' });
});

/** The config and roster of a past match, so it can be set up again. */
route('GET', '/api/matches/:id/setup', (_req, res, params) => {
  const id = resolveMatchId(params.id ?? '');
  const setup = id ? store.setupOf(id) : null;
  setup ? json(res, 200, setup) : json(res, 404, { error: 'no such match' });
});

route('GET', '/api/state', (_req, res) =>
  json(res, 200, { view: manager.view, boardOnline: manager.isBoardOnline }),
);

route('POST', '/api/matches', (_req, res, _p, body) => {
  const b = body as { config?: unknown; playerIds?: unknown };
  const config = GameConfigSchema.safeParse(b?.config);
  if (!config.success) return json(res, 400, { error: config.error.message });

  const ids = Array.isArray(b?.playerIds) ? (b.playerIds as string[]) : [];
  if (ids.length === 0) return json(res, 400, { error: 'at least one player is required' });

  const players = ids.map((id) => store.getProfile(id)).filter((p) => p !== null);
  if (players.length !== ids.length) return json(res, 400, { error: 'unknown profile id' });

  // Golf is played off a handicap derived from past rounds. It is resolved
  // here and written into the match config, so the round stays reproducible
  // from its own record even after the player's handicap has moved on.
  const resolved =
    config.data.gameType === 'golf'
      ? {
          ...config.data,
          handicaps: Object.fromEntries(
            players.map((p) => [
              p.id,
              config.data.gameType === 'golf' && config.data.handicaps[p.id] !== undefined
                ? (config.data.handicaps[p.id] as number)
                : store.golfHandicapFor(p.id).handicap,
            ]),
          ),
        }
      : config.data;

  const view = manager.start(
    resolved,
    players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
  json(res, 201, view);
});

route('POST', '/api/match/command', (_req, res, _p, body) => {
  const cmd = MatchCommandSchema.safeParse((body as { command?: unknown })?.command);
  if (!cmd.success) return json(res, 400, { error: cmd.error.message });
  const view = manager.apply(cmd.data);
  view ? json(res, 200, view) : json(res, 409, { error: 'no active match' });
});

/**
 * Virtual dartboard input. Forwarded to the bridge rather than applied here, so
 * simulated darts travel the same path real ones will.
 */
route('POST', '/api/simulate', async (_req, res, _p, body) => {
  const segment = SegmentSchema.safeParse((body as { segment?: unknown })?.segment);
  if (!segment.success) return json(res, 400, { error: 'expected { segment }' });
  const coords = CoordsSchema.safeParse((body as { coords?: unknown })?.coords);
  try {
    const upstream = await fetch(`${BRIDGE_HTTP}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        segment: segment.data,
        coords: coords.success ? coords.data : null,
      }),
    });
    json(res, upstream.status, await upstream.json().catch(() => ({})));
  } catch (err) {
    json(res, 502, { error: `bridge unreachable: ${(err as Error).message}` });
  }
});

/** Add a player to the match already in progress. */
route('POST', '/api/match/players', (_req, res, _p, body) => {
  const id = (body as { profileId?: unknown })?.profileId;
  if (typeof id !== 'string') return json(res, 400, { error: 'profileId is required' });
  const profile = store.getProfile(id);
  if (!profile) return json(res, 404, { error: 'unknown profile' });
  const view = manager.apply({
    type: 'ADD_PLAYER',
    player: { id: profile.id, name: profile.name, color: profile.color },
  });
  view ? json(res, 200, view) : json(res, 409, { error: 'no active match' });
});

route('DELETE', '/api/match/players/:profileId', (_req, res, params) => {
  const view = manager.apply({ type: 'REMOVE_PLAYER', playerId: params.profileId ?? '' });
  view ? json(res, 200, view) : json(res, 409, { error: 'no active match' });
});

// -- bridge source ----------------------------------------------------------

/**
 * The desired source configuration lives here rather than in the bridge's
 * environment, so a choice made on the settings screen survives a restart of
 * either process. It is pushed to the bridge on every reconnect.
 */
function storedSourceConfig(): unknown {
  return store.getSetting<unknown>('bridgeSource', null);
}

async function pushSourceToBridge(config: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/source`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `bridge returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Re-apply the stored configuration whenever the bridge comes back. */
async function syncSourceToBridge(): Promise<void> {
  const config = storedSourceConfig();
  if (!config) return;
  const result = await pushSourceToBridge(config);
  if (result.ok) console.log('[server] pushed stored source config to bridge');
  else console.warn(`[server] could not push source config: ${result.error}`);
}

route('GET', '/api/bridge/source', async (_req, res) => {
  try {
    const upstream = await fetch(`${BRIDGE_HTTP}/source`);
    const live = await upstream.json();
    json(res, 200, { ...(live as object), stored: storedSourceConfig() });
  } catch (err) {
    json(res, 502, { error: `bridge unreachable: ${(err as Error).message}` });
  }
});

route('PUT', '/api/bridge/source', async (_req, res, _p, body) => {
  const config = (body as { config?: unknown })?.config;
  if (!config || typeof config !== 'object') {
    return json(res, 400, { error: 'expected { config }' });
  }
  const result = await pushSourceToBridge(config);
  if (!result.ok) return json(res, 502, { error: result.error });
  // Only persist once the bridge has accepted it, so a rejected config does
  // not get replayed on every reconnect.
  store.setSetting('bridgeSource', config);
  json(res, 200, { ok: true, config });
});

/** Check a board is reachable before switching to it. */
route('POST', '/api/bridge/test', async (_req, res, _p, body) => {
  const url = (body as { url?: unknown })?.url;
  if (typeof url !== 'string') return json(res, 400, { error: 'expected { url }' });
  try {
    const upstream = await fetch(`${BRIDGE_HTTP}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    json(res, upstream.status, await upstream.json());
  } catch (err) {
    json(res, 502, { error: `bridge unreachable: ${(err as Error).message}` });
  }
});

// -- settings ---------------------------------------------------------------

route('GET', '/api/settings', async (_req, res) => {
  let bridge: unknown = null;
  try {
    const upstream = await fetch(`${BRIDGE_HTTP}/source`, { signal: AbortSignal.timeout(2000) });
    bridge = await upstream.json();
  } catch {
    // The settings screen still works with the bridge down; it just cannot
    // show what the bridge is currently running.
  }
  json(res, 200, {
    coordsEnabled: store.getSetting('coordsEnabled', process.env.COORDS_ENABLED === '1'),
    celebrations: store.getSetting('celebrations', true),
    celebrationSeconds: store.getSetting('celebrationSeconds', 6),
    bridge,
    runtime: {
      bridgeWs: BRIDGE_WS,
      dbFile: DB_FILE,
      boardOnline: manager.isBoardOnline,
    },
  });
});

route('PUT', '/api/settings', (_req, res, _p, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.coordsEnabled === 'boolean') store.setSetting('coordsEnabled', b.coordsEnabled);
  if (typeof b.celebrations === 'boolean') store.setSetting('celebrations', b.celebrations);
  if (typeof b.celebrationSeconds === 'number') {
    store.setSetting('celebrationSeconds', Math.min(30, Math.max(1, b.celebrationSeconds)));
  }
  json(res, 200, store.allSettings());
});

route('POST', '/api/recompute', (_req, res) => {
  const result = store.recomputeAll({
    coordsEnabled: store.getSetting('coordsEnabled', process.env.COORDS_ENABLED === '1'),
  });
  // A rebuild only sees finished matches; re-apply anything earned in the match
  // still being played.
  manager.revalidateAchievements();
  json(res, 200, result);
});

// -- server -----------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(match[i + 1] ?? '');
    });
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    if (body === null) return json(res, 400, { error: 'invalid JSON body' });
    try {
      await r.handler(req, res, params, body);
    } catch (err) {
      console.error('[server] handler failed:', err);
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
    return;
  }
  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'view', view: manager.view } satisfies ServerEvent));
  socket.on('close', () => clients.delete(socket));
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}  db=${DB_FILE}`);
  connectToBridge(BRIDGE_WS, (e) => manager.onBoardEvent(e), {
    onConnect: () => void syncSourceToBridge(),
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal}, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
