import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { FakeBoard } from './board.ts';
import { handleControl } from './control.ts';
import { handleApi } from './http.ts';
import { startPeriodicFrames } from './frames.ts';

export interface FakeBoardOptions {
  /** 0 picks a free port, which is what tests want. */
  port?: number;
  /** Emit the 30/s motion channel. Off by default; see frames.ts. */
  motion?: boolean;
  /** Start with detection already running, so no PUT /api/start is needed. */
  autoStart?: boolean;
}

export interface RunningFakeBoard {
  readonly port: number;
  readonly url: string;
  readonly board: FakeBoard;
  disconnect(ms: number): void;
  /**
   * Stop the periodic channels but hold the socket open: a board that is still
   * connected yet has stopped producing frames. This is the only way to reach
   * the bridge's heartbeat timeout, since closing the server would trip the
   * much cruder "socket closed" path instead.
   */
  silence(): void;
  close(): Promise<void>;
}

export function startFakeBoard(opts: FakeBoardOptions = {}): Promise<RunningFakeBoard> {
  const board = new FakeBoard();
  const clients = new Set<WebSocket>();
  /** Epoch ms until which websocket upgrades are refused. */
  let blockedUntil = 0;

  const broadcast = (type: string, data: unknown): void => {
    const payload = JSON.stringify({ type, data });
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };

  const disconnect = (ms: number): void => {
    blockedUntil = Date.now() + ms;
    for (const client of clients) client.terminate();
    clients.clear();
  };

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (await handleControl(req, res, { board, disconnect })) return;
        if (handleApi(req, res, board)) return;
        // Unlike the real board there is no cloud-proxied SPA behind us, so
        // anything unrecognised is simply absent.
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/events',
    // Refusing the upgrade outright is what a board that is off or unreachable
    // looks like: the bridge never sees an open, so it backs off and retries.
    verifyClient: (_info, cb) => cb(Date.now() >= blockedUntil, 503),
  });

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    // No greeting frame and no subscribe handshake: the real board sends
    // nothing on connect and went silent for a full 45 s idle capture
    // (FINDINGS §1). The bridge must learn liveness from `stats` alone.
  });

  // `state` is edge-triggered: it goes out when, and only when, the board's
  // state actually changes.
  board.on((data) => broadcast('state', data));

  let stopFrames = startPeriodicFrames(broadcast, { motion: opts.motion });
  const silence = (): void => {
    stopFrames();
    stopFrames = () => {};
  };

  if (opts.autoStart) board.start();

  return new Promise((resolve) => {
    httpServer.listen(opts.port ?? 3180, () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? 3180);
      resolve({
        port,
        url: `http://localhost:${port}`,
        board,
        disconnect,
        silence,
        close: () =>
          new Promise<void>((done) => {
            stopFrames();
            for (const client of clients) client.terminate();
            clients.clear();
            wss.close(() => httpServer.close(() => done()));
          }),
      });
    });
  });
}
