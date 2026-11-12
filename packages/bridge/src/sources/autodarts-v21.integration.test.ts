import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardEventSchema, type BoardEvent } from '@darts/schema';
import { boardState } from '../boardControl.ts';
import { autodartsSource } from './autodarts.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function board() {
  let state = { connected: true, running: true, status: 'throw', throws: [] as unknown[] };
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(state));
  });
  const sockets = new WebSocketServer({ server, path: '/api/events' });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
  });
  const sendFrame = (frame: unknown) => {
    for (const socket of sockets.clients) socket.send(JSON.stringify(frame));
  };
  return {
    url: `http://127.0.0.1:${address.port}`,
    sendFrame,
    send(status: string, throws: unknown[]) {
      state = { ...state, status, throws };
      sendFrame({ type: 'state', data: state });
    },
  };
}

const dart = { segmentName: 'T20', segmentNumber: 20, bed: 'Triple', multiplier: 3, coordsX: 0, coordsY: 0.6 };

it('replays the real 2.1.1 visit without duplicating the dart reported before throwDetected', async () => {
  // Captured on our board, 2026-11-12: T5, S13, S7, then takeout.
  // The first dart appears in a takeoutFinished frame, then repeats in
  // throwDetected. Both frames must produce just one scoring event together.
  const frames = readFileSync(new URL('../fixtures/autodarts-2.1.1-turn.ndjson', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as unknown);
  const b = await board();
  const events: BoardEvent[] = [];
  const source = autodartsSource({ baseUrl: b.url, pollIntervalMs: 0 });
  cleanup.push(() => source.stop());
  source.start(event => events.push(event));
  await vi.waitFor(() => expect(events.some(e => e.type === 'board.connected')).toBe(true));
  for (const frame of frames) b.sendFrame(frame);
  await vi.waitFor(() => expect(events.some(e => e.type === 'takeout.completed')).toBe(true));
  const darts = events.filter(e => e.type === 'throw.detected');
  expect(darts.map(e => e.throw.value)).toEqual([15, 13, 7]);
  expect(darts.map(e => e.throw.segment)).toEqual([
    { number: 5, ring: 'TRIPLE' },
    { number: 13, ring: 'SINGLE_INNER' },
    { number: 7, ring: 'SINGLE_INNER' },
  ]);
  expect(events.filter(e => e.type.startsWith('takeout.')).map(e => e.type))
    .toEqual(['takeout.started', 'takeout.completed']);
  expect(events.filter(e => e.type === 'board.status').at(-1))
    .toMatchObject({ status: 'Throw', running: true });
  for (const event of events) expect(BoardEventSchema.safeParse(event).success).toBe(true);
});

it('accepts 2.1 status, scores cumulative flat darts once and completes the takeout', async () => {
  const b = await board();
  const events: BoardEvent[] = [];
  const source = autodartsSource({ baseUrl: b.url, pollIntervalMs: 0 });
  cleanup.push(() => source.stop());
  source.start((event) => events.push(event));
  await vi.waitFor(() => expect(events.some(e => e.type === 'board.connected')).toBe(true));
  b.send('throw', [dart]);
  b.send('throw', [dart, dart]);
  b.send('takeout', [dart, dart, dart]);
  b.send('takeoutInProgress', [dart, dart, dart]);
  b.send('throw', []);
  await vi.waitFor(() => expect(events.some(e => e.type === 'takeout.completed')).toBe(true));
  expect(events.filter(e => e.type === 'throw.detected').map(e => e.throw.value)).toEqual([60, 60, 60]);
  expect(events.filter(e => e.type.startsWith('takeout.')).map(e => e.type))
    .toEqual(['takeout.started', 'takeout.completed']);
  expect(events.filter(e => e.type === 'board.status').map(e => e.status))
    .toEqual(['Throw', 'Throw', 'Takeout', 'Takeout in progress', 'Throw']);
  // The game server validates every bridge event: camelCase must not escape.
  for (const event of events) expect(BoardEventSchema.safeParse(event).success).toBe(true);
});

it('restores idle status from HTTP without scoring old darts from a snapshot', async () => {
  const b = await board();
  b.send('takeout', [dart, dart, dart]);
  const events: BoardEvent[] = [];
  const source = autodartsSource({ baseUrl: b.url, pollIntervalMs: 100 });
  cleanup.push(() => source.stop());
  source.start((event) => events.push(event));
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'board.status', status: 'Takeout', running: true }));
  expect(events.some(e => e.type === 'throw.detected')).toBe(false);
});

it('normalizes the settings snapshot and derives the count absent in 2.1', async () => {
  const b = await board();
  b.send('takeoutInProgress', [dart, dart]);
  expect(await boardState(b.url)).toMatchObject({
    ok: true, state: { running: true, status: 'Takeout in progress', numThrows: 2 },
  });
});
