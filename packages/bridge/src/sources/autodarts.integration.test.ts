import { afterEach, describe, expect, it } from 'vitest';
import { startFakeBoard, type RunningFakeBoard } from '@darts/fakeboard';
import type { BoardEvent } from '@darts/schema';
import { autodartsSource } from './autodarts.ts';
import type { Source } from './types.ts';

/**
 * The live board path, end to end over a real websocket.
 *
 * The simulator and replay sources both bypass the network, which left
 * everything transport-shaped in autodarts.ts untested: reconnection, the
 * heartbeat timeout, the dedupe against a cumulative `throws[]`, takeout
 * detection. Those are the parts most likely to be wrong and the hardest to
 * exercise by hand, so they get a fake board instead of hardware.
 *
 * CAVEAT: the fake emits the throw payload that recon/FINDINGS.md §3 *infers*
 * from the board UI bundle. These tests prove the bridge handles that shape
 * correctly — they cannot prove the shape is right. Only a capture from the
 * real board settles that.
 */

let fake: RunningFakeBoard | null = null;
let source: Source | null = null;

afterEach(async () => {
  await source?.stop();
  source = null;
  await fake?.close();
  fake = null;
});

interface Harness {
  events: BoardEvent[];
  /** Wait until `predicate` holds over the events seen so far. */
  until(predicate: (events: BoardEvent[]) => boolean, timeoutMs?: number): Promise<void>;
}

async function connect(opts: { heartbeatTimeoutMs?: number; debugMotion?: boolean } = {}) {
  fake = await startFakeBoard({ port: 0, autoStart: true, motion: opts.debugMotion });
  const events: BoardEvent[] = [];

  const harness: Harness = {
    events,
    async until(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out; saw: ${events.map((e) => e.type).join(', ')}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };

  source = autodartsSource({
    baseUrl: fake.url,
    debugMotion: opts.debugMotion ?? false,
    ...(opts.heartbeatTimeoutMs ? { heartbeatTimeoutMs: opts.heartbeatTimeoutMs } : {}),
  });
  source.start((event) => events.push(event));
  await harness.until((e) => e.some((x) => x.type === 'board.connected'));
  return { fake, harness };
}

const throwsOf = (events: BoardEvent[]) =>
  events.filter((e): e is Extract<BoardEvent, { type: 'throw.detected' }> => e.type === 'throw.detected');

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
}

describe('connecting to a board', () => {
  it('reports connected and then heartbeats from the stats channel', async () => {
    const { harness } = await connect();
    await harness.until((e) => e.some((x) => x.type === 'board.heartbeat'));
    const beat = harness.events.find((e) => e.type === 'board.heartbeat');
    expect(beat).toMatchObject({ fps: 30 });
  });

  it('drops the 30/s motion channel', async () => {
    const { harness } = await connect({ debugMotion: false });
    // Two heartbeats means at least ~60 motion frames went past unremarked.
    await harness.until((e) => e.filter((x) => x.type === 'board.heartbeat').length >= 2, 6000);
    expect(throwsOf(harness.events)).toHaveLength(0);
  });
});

describe('a turn', () => {
  it('emits each dart exactly once from a cumulative throws array', async () => {
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/turn`, { segments: ['T20', 'T20', 'T20'] });

    await harness.until((e) => e.some((x) => x.type === 'takeout.completed'));
    const darts = throwsOf(harness.events);
    // Three darts, not six: the board reports every dart still in the board on
    // each frame, so frame 3 repeats darts 1 and 2.
    expect(darts).toHaveLength(3);
    expect(darts.map((d) => d.throw.value)).toEqual([60, 60, 60]);
    expect(darts.map((d) => d.throw.segment)).toEqual([
      { number: 20, ring: 'TRIPLE' },
      { number: 20, ring: 'TRIPLE' },
      { number: 20, ring: 'TRIPLE' },
    ]);
  });

  it('reports the takeout in two stages', async () => {
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/turn`, { segments: ['T20'] });
    await harness.until((e) => e.some((x) => x.type === 'takeout.completed'));

    const order = harness.events.map((e) => e.type);
    expect(order.indexOf('takeout.started')).toBeLessThan(order.indexOf('takeout.completed'));
  });

  it('starts counting from zero again on the next turn', async () => {
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/turn`, { segments: ['T20', 'T20', 'T20'] });
    await harness.until((e) => e.some((x) => x.type === 'takeout.completed'));
    await post(`${fake.url}/sim/turn`, { segments: ['D16'] });
    await harness.until((e) => throwsOf(e).length >= 4);

    const darts = throwsOf(harness.events);
    expect(darts).toHaveLength(4);
    expect(darts[3]?.throw.value).toBe(32);
  });

  it('does not read a reset we asked for as a takeout', async () => {
    // Reset is a detection control, pressed mid-visit with the darts still in
    // the board. Its counter drop looks exactly like a takeout on the wire, so
    // the source is told first -- otherwise the server would end the turn.
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/throw`, { segment: 'T20' });
    await harness.until((e) => throwsOf(e).length >= 1);

    source?.noteCounterReset?.();
    await fetch(`${fake.url}/api/reset`, { method: 'POST' });

    // The dart after the reset still arrives, and no takeout was reported.
    await post(`${fake.url}/sim/throw`, { segment: 'D16' });
    await harness.until((e) => throwsOf(e).length >= 2);
    expect(throwsOf(harness.events).map((d) => d.throw.value)).toEqual([60, 32]);
    expect(harness.events.some((e) => e.type === 'takeout.completed')).toBe(false);
  });

  it('still reports a real takeout after a reset', async () => {
    // One reset arms one silent drop and no more: the takeout that follows is
    // a person pulling darts out, and the turn must end on it.
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/throw`, { segment: 'T20' });
    await harness.until((e) => throwsOf(e).length >= 1);

    source?.noteCounterReset?.();
    await fetch(`${fake.url}/api/reset`, { method: 'POST' });
    await post(`${fake.url}/sim/turn`, { segments: ['T20'] });

    await harness.until((e) => e.some((x) => x.type === 'takeout.completed'));
  });

  it('scores every ring the board can report', async () => {
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/turn`, { segments: ['BULL', '25', 'MISS'] });
    await harness.until((e) => throwsOf(e).length >= 3);

    expect(throwsOf(harness.events).map((d) => d.throw.value)).toEqual([50, 25, 0]);
  });

  it('converts board coordinates into schema mm, y flipped', async () => {
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/turn`, { segments: ['T20'] });
    await harness.until((e) => throwsOf(e).length >= 1);

    // T20 sits dead centre of its wedge, straight up from the bull, so the
    // fake board's own formula puts it on the y axis with no x component.
    const coords = throwsOf(harness.events)[0]?.throw.coords;
    expect(coords?.x).toBeCloseTo(0, 5);
    expect(coords?.y).toBeGreaterThan(0);
  });

  it('forwards the board status', async () => {
    const { fake, harness } = await connect();
    await post(`${fake.url}/sim/throw`, { segment: 'T20' });
    await harness.until((e) => e.some((x) => x.type === 'board.status'));

    const status = harness.events.find((e) => e.type === 'board.status');
    expect(status).toMatchObject({ status: 'Throw', running: true });
  });
});

describe('losing the board', () => {
  it('reconnects after a dropout and scores darts again', async () => {
    const { fake, harness } = await connect();
    fake.disconnect(300);
    await harness.until((e) => e.some((x) => x.type === 'board.disconnected'), 8000);

    // The source backs off exponentially from 500ms, so this takes a moment.
    await harness.until(
      (e) => e.filter((x) => x.type === 'board.connected').length >= 2,
      10_000,
    );

    await post(`${fake.url}/sim/turn`, { segments: ['T20'] });
    await harness.until((e) => throwsOf(e).length >= 1);
    expect(throwsOf(harness.events)[0]?.throw.value).toBe(60);
  }, 20_000);

  it('goes offline when stats stop, even though state is legitimately silent', async () => {
    // The heartbeat rule that matters: `state` produced zero frames in a 45s
    // capture of a healthy idle board, so silence there means nothing. Only
    // missing `stats` means the board is gone.
    const { fake, harness } = await connect({ heartbeatTimeoutMs: 400 });
    // Go quiet without dropping the socket, so the only thing that can raise
    // the alarm is the missing heartbeat.
    fake.silence();

    await harness.until((e) =>
      e.some((x) => x.type === 'board.disconnected'),
    );
  });
});
