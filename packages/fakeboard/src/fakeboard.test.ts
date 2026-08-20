import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { FakeBoard } from './board.ts';
import { toRawThrow } from './payload.ts';
import { startFakeBoard, type RunningFakeBoard } from './server.ts';

let running: RunningFakeBoard | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function boot(autoStart = true): Promise<RunningFakeBoard> {
  running = await startFakeBoard({ port: 0, autoStart });
  return running;
}

/** Collect frames off the events socket until `want` of `type` have arrived. */
function collect(url: string, type: string, want: number, timeoutMs = 4000) {
  return new Promise<unknown[]>((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen: unknown[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`only saw ${seen.length}/${want} "${type}" frames`));
    }, timeoutMs);
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type?: string; data?: unknown };
      if (frame.type !== type) return;
      seen.push(frame.data);
      if (seen.length >= want) {
        clearTimeout(timer);
        ws.close();
        resolve(seen);
      }
    });
    ws.on('error', reject);
  });
}

describe('the board state machine', () => {
  it('emits only on transitions, never on a timer', async () => {
    const board = new FakeBoard();
    const frames: unknown[] = [];
    board.on((d) => frames.push(d));

    board.start();
    expect(frames).toHaveLength(1);

    // Starting an already-running board is not a transition.
    board.start();
    expect(frames).toHaveLength(1);

    board.throwDart({ number: 20, ring: 'TRIPLE' });
    expect(frames).toHaveLength(2);
  });

  it('accumulates darts for the visit and clears them on takeout', () => {
    const board = new FakeBoard();
    board.start();
    board.throwDart({ number: 20, ring: 'TRIPLE' });
    board.throwDart({ number: 20, ring: 'TRIPLE' });
    expect(board.snapshot().throws).toHaveLength(2);
    expect(board.snapshot().numThrows).toBe(2);

    board.takeoutStart();
    expect(board.snapshot().status).toBe('Takeout in progress');
    expect(board.snapshot().throws).toHaveLength(2);

    board.takeoutComplete();
    expect(board.snapshot().throws).toHaveLength(0);
    expect(board.snapshot().status).toBe('Throw');
  });

  it('ignores darts while detection is stopped', () => {
    const board = new FakeBoard();
    board.throwDart({ number: 20, ring: 'TRIPLE' });
    expect(board.snapshot().throws).toHaveLength(0);
  });
});

describe('the throw payload', () => {
  it('writes the field names the adapter reads', () => {
    expect(toRawThrow({ number: 20, ring: 'TRIPLE' }).segment).toEqual({
      name: 'T20',
      bed: 'Triple',
    });
    expect(toRawThrow({ number: 5, ring: 'SINGLE_INNER' }).segment).toEqual({
      name: 'S5',
      bed: 'SingleInner',
    });
    expect(toRawThrow({ number: 25, ring: 'BULL' }).segment).toEqual({ name: 'DB', bed: 'Double' });
    expect(toRawThrow({ number: 0, ring: 'MISS' }).segment.bed).toBe('Outside');
  });

  it('puts 20 at the top and 3 at the bottom', () => {
    // Guards the coordinate convention this file assumes: origin at the bull,
    // y down. If a real capture says otherwise, this test changes with it.
    const top = toRawThrow({ number: 20, ring: 'DOUBLE' }).coords;
    expect(top.x).toBeCloseTo(0, 3);
    expect(top.y).toBeLessThan(0);

    const bottom = toRawThrow({ number: 3, ring: 'DOUBLE' }).coords;
    expect(bottom.x).toBeCloseTo(0, 3);
    expect(bottom.y).toBeGreaterThan(0);

    expect(toRawThrow({ number: 25, ring: 'BULL' }).coords).toEqual({ x: 0, y: 0 });
  });
});

describe('the control API', () => {
  it('answers ping and version like the real board', async () => {
    const fake = await boot();
    expect(await (await fetch(`${fake.url}/api/ping`)).text()).toBe('pong');
    expect(await (await fetch(`${fake.url}/api/version`)).text()).toBe('1.0.7');
  });

  it('never sends a Cf-Ray header, so recon probing stays honest', async () => {
    const fake = await boot();
    const res = await fetch(`${fake.url}/api/ping`);
    expect(res.headers.get('cf-ray')).toBeNull();
  });

  it('starts and stops detection', async () => {
    const fake = await boot(false);
    expect((await (await fetch(`${fake.url}/api/state`)).json()).running).toBe(false);

    const started = await (await fetch(`${fake.url}/api/start`, { method: 'PUT' })).json();
    expect(started).toMatchObject({ running: true, status: 'Throw', event: 'Started' });

    const stopped = await (await fetch(`${fake.url}/api/stop`, { method: 'PUT' })).json();
    expect(stopped).toMatchObject({ running: false, status: 'Stopped' });
  });

  it('refuses a plain GET on the events path', async () => {
    const fake = await boot();
    expect((await fetch(`${fake.url}/api/events`)).status).toBe(400);
  });

  it('404s an unknown board path rather than inventing a body', async () => {
    const fake = await boot();
    expect((await fetch(`${fake.url}/api/nonsense`)).status).toBe(404);
  });

  it('throws darts by compact label', async () => {
    const fake = await boot();
    const res = await fetch(`${fake.url}/sim/throw`, {
      method: 'POST',
      body: JSON.stringify({ segment: 'T20' }),
    });
    expect(res.status).toBe(202);
    expect(fake.board.snapshot().throws[0]?.segment.name).toBe('T20');
  });

  it('rejects a dart while detection is stopped', async () => {
    const fake = await boot(false);
    const res = await fetch(`${fake.url}/sim/throw`, {
      method: 'POST',
      body: JSON.stringify({ segment: 'T20' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('the events socket', () => {
  it('pushes stats without any subscribe frame', async () => {
    const fake = await boot();
    const stats = await collect(`ws://localhost:${fake.port}/api/events`, 'stats', 2);
    expect(stats[0]).toMatchObject({ fps: 30 });
  });

  it('pushes a state frame per transition', async () => {
    const fake = await boot();
    const wanted = collect(`ws://localhost:${fake.port}/api/events`, 'state', 2);
    // Give the socket a moment to attach before making the transitions.
    await new Promise((r) => setTimeout(r, 100));
    fake.board.throwDart({ number: 20, ring: 'TRIPLE' });
    fake.board.throwDart({ number: 20, ring: 'TRIPLE' });

    const frames = (await wanted) as { throws: unknown[] }[];
    expect(frames[0]?.throws).toHaveLength(1);
    expect(frames[1]?.throws).toHaveLength(2);
  });

  it('refuses connections while disconnected', async () => {
    const fake = await boot();
    fake.disconnect(500);
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${fake.port}/api/events`);
        ws.on('open', () => resolve('opened'));
        ws.on('error', reject);
      }),
    ).rejects.toThrow();
  });
});
