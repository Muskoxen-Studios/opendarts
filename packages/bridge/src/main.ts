import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CoordsSchema, SegmentSchema, type BoardEvent } from '@darts/schema';
import { configFromEnv, describeSource, SourceConfigSchema } from './sourceConfig.ts';
import { describeFetchError } from './fetchError.ts';
import { boardCommand, boardState, isBoardAction } from './boardControl.ts';
import { SourceManager } from './sourceManager.ts';

const PORT = Number(process.env.BRIDGE_PORT ?? 8081);

const clients = new Set<WebSocket>();
/** Last known board status, replayed to clients that connect later. */
let lastStatus: BoardEvent | null = null;

function broadcast(event: BoardEvent): void {
  if (event.type === 'board.status') lastStatus = event;
  if (event.type === 'board.disconnected') lastStatus = null;
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

const manager = new SourceManager(configFromEnv(), broadcast);

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(text);
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

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.url === '/health') {
    json(res, 200, {
      ok: true,
      source: manager.name,
      config: manager.config,
      description: manager.description,
      clients: clients.size,
    });
    return;
  }

  // Current source configuration.
  if (req.url === '/source' && req.method === 'GET') {
    json(res, 200, {
      config: manager.config,
      description: manager.description,
      acceptsInjection: manager.acceptsInjection,
    });
    return;
  }

  // Switch source while running -- no restart, no redeploy.
  if (req.url === '/source' && req.method === 'PUT') {
    const body = await readBody(req);
    const parsed = SourceConfigSchema.safeParse((body as { config?: unknown })?.config);
    if (!parsed.success) {
      json(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    manager.apply(parsed.data);
    json(res, 200, {
      config: manager.config,
      description: manager.description,
      acceptsInjection: manager.acceptsInjection,
    });
    return;
  }

  /**
   * Check a board is actually reachable before switching to it, so a typo in
   * the address shows up as an error message rather than a silently dead board.
   */
  if (req.url === '/test' && req.method === 'POST') {
    const body = await readBody(req);
    const url = (body as { url?: unknown })?.url;
    if (typeof url !== 'string') {
      json(res, 400, { error: 'expected { url }' });
      return;
    }
    try {
      const base = url.replace(/\/$/, '');
      const started = Date.now();
      const ping = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(4000) });
      const text = (await ping.text()).trim();
      if (!ping.ok || text !== 'pong') {
        json(res, 200, { ok: false, error: `expected "pong" from ${base}/api/ping, got "${text.slice(0, 40)}"` });
        return;
      }
      let version: string | null = null;
      try {
        const v = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(4000) });
        version = v.ok ? (await v.text()).trim() : null;
      } catch {
        // Version is a nicety; a working ping is what matters.
      }
      json(res, 200, { ok: true, version, latencyMs: Date.now() - started });
    } catch (err) {
      const base = url.replace(/\/$/, '');
      json(res, 200, { ok: false, error: describeFetchError(err, base) });
    }
    return;
  }

  /**
   * The board's own controls: start, stop, reset, calibrate, plus its state.
   *
   * A thin pass-through to the Board Manager's local API. It lives here rather
   * than in the game server because the bridge is the only process that knows
   * a board's address, and rather than in the browser because the board is on
   * the house network, not necessarily on the one serving the UI.
   *
   * Only meaningful when a board is the active source. On the simulator there
   * is no board to start, and saying so is more useful than a dead button.
   */
  if (req.url?.startsWith('/board')) {
    const boardUrl = manager.config.kind === 'autodarts' ? manager.config.url : null;
    if (!boardUrl) {
      // Not an error status: "there is no board" is a true answer to the
      // question, and the caller needs to tell it apart from a board that is
      // attached but unreachable. `attached` is what says which.
      json(res, 200, {
        ok: false,
        attached: false,
        error: `no board attached — the active source is "${manager.config.kind}"`,
      });
      return;
    }

    if (req.url === '/board/state' && req.method === 'GET') {
      const result = await boardState(boardUrl);
      json(res, 200, { ...result, attached: true, url: boardUrl });
      return;
    }

    const action = req.url.slice('/board/'.length);
    if (req.method === 'POST' && isBoardAction(action)) {
      const result = await boardCommand(boardUrl, action);
      json(res, 200, { ...result, attached: true, action, url: boardUrl });
      return;
    }

    json(res, 404, { error: `unknown board control "${req.url}"` });
    return;
  }

  // Injection endpoint used by the frontend's virtual dartboard. Routing it
  // through the bridge rather than straight into the game server means the
  // simulated path exercises the same wire hop that real darts will.
  if (req.url === '/inject' && req.method === 'POST') {
    if (!manager.acceptsInjection) {
      json(res, 409, { error: `source "${manager.name}" does not accept injected darts` });
      return;
    }
    const body = await readBody(req);
    const parsed = SegmentSchema.safeParse((body as { segment?: unknown })?.segment);
    if (!parsed.success) {
      json(res, 400, { error: 'expected { segment: { number, ring } }' });
      return;
    }
    // Coordinates are optional: a caller that has them (the virtual board) may
    // pass them, and one that does not is no less valid.
    const coords = CoordsSchema.safeParse((body as { coords?: unknown })?.coords);
    manager.inject(parsed.data, coords.success ? coords.data : null);
    json(res, 202, { ok: true });
    return;
  }

  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/events' });

wss.on('connection', (socket) => {
  clients.add(socket);
  console.log(`[bridge] client connected (${clients.size} total)`);
  socket.send(JSON.stringify({ type: 'board.connected' } satisfies BoardEvent));
  if (lastStatus) socket.send(JSON.stringify(lastStatus));
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[bridge] client disconnected (${clients.size} remaining)`);
  });
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on :${PORT}`);
  console.log(`[bridge] source=${describeSource(manager.config)}`);
  manager.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[bridge] ${signal}, shutting down`);
    manager.stop();
    server.close(() => process.exit(0));
  });
}
