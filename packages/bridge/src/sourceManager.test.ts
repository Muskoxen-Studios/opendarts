import { describe, it, expect, beforeEach } from 'vitest';
import type { BoardEvent, Segment } from '@darts/schema';
import type { SourceConfig } from './sourceConfig.ts';
import { SourceManager } from './sourceManager.ts';
import type { EventSink, Source } from './sources/types.ts';

/** A source we can drive by hand, including misbehaving after being stopped. */
function fakeSource(name: string) {
  let sink: EventSink | null = null;
  let stopped = false;
  const source: Source = {
    name,
    start(emit) {
      sink = emit;
      stopped = false;
    },
    stop() {
      stopped = true;
    },
    inject(segment: Segment) {
      sink?.({
        type: 'throw.detected',
        throw: {
          id: `${name}-1`, ts: '2026-01-01T00:00:00.000Z',
          segment, value: 0, coords: null, source: 'simulator',
        },
      });
    },
  };
  return {
    source,
    get stopped() { return stopped; },
    /** Emit as though the source were still live. */
    leak(event: BoardEvent) { sink?.(event); },
  };
}

const SIM: SourceConfig = { kind: 'simulator' };
const BOARD: SourceConfig = { kind: 'autodarts', url: 'http://192.168.1.5:3180', debugMotion: false };

let events: BoardEvent[];
beforeEach(() => { events = []; });

describe('switching source at runtime', () => {
  it('starts the configured source', () => {
    const fake = fakeSource('simulator');
    const m = new SourceManager(SIM, (e) => events.push(e), () => fake.source);
    m.start();
    expect(m.name).toBe('simulator');
    expect(m.config).toEqual(SIM);
  });

  it('stops the old source and starts the new one', () => {
    const first = fakeSource('simulator');
    const second = fakeSource('autodarts');
    const made: Source[] = [];
    const m = new SourceManager(SIM, (e) => events.push(e), (cfg) => {
      const s = cfg.kind === 'simulator' ? first.source : second.source;
      made.push(s);
      return s;
    });

    m.start();
    m.apply(BOARD);

    expect(first.stopped).toBe(true);
    expect(m.name).toBe('autodarts');
    expect(m.config).toEqual(BOARD);
    expect(made).toHaveLength(2);
  });

  it('announces the disconnect so the UI does not show a stale board', () => {
    const fake = fakeSource('simulator');
    const m = new SourceManager(SIM, (e) => events.push(e), () => fake.source);
    m.start();
    m.apply(BOARD);
    expect(events).toContainEqual({ type: 'board.disconnected', reason: 'source changed' });
  });

  it('ignores events from a source that has been replaced', () => {
    const stale = fakeSource('simulator');
    const fresh = fakeSource('autodarts');
    let first = true;
    const m = new SourceManager(SIM, (e) => events.push(e), () => {
      if (first) { first = false; return stale.source; }
      return fresh.source;
    });

    m.start();
    m.apply(BOARD);
    events = [];

    // A socket closing late, or a timer that had already fired, must not be
    // able to inject a dart into the match now running on the new source.
    stale.leak({ type: 'throw.detected', throw: {
      id: 'ghost', ts: '2026-01-01T00:00:00.000Z',
      segment: { number: 20, ring: 'TRIPLE' }, value: 60, coords: null, source: 'board',
    } });
    expect(events).toHaveLength(0);

    fresh.leak({ type: 'board.heartbeat' });
    expect(events).toEqual([{ type: 'board.heartbeat' }]);
  });

  it('reports whether the active source takes injected darts', () => {
    const withInject = fakeSource('simulator');
    const noInject: Source = { name: 'autodarts', start() {}, stop() {} };
    let first = true;
    const m = new SourceManager(SIM, (e) => events.push(e), () => {
      if (first) { first = false; return withInject.source; }
      return noInject;
    });
    m.start();
    expect(m.acceptsInjection).toBe(true);
    m.apply(BOARD);
    expect(m.acceptsInjection).toBe(false);
    expect(m.inject({ number: 20, ring: 'TRIPLE' })).toBe(false);
  });

  it('can be switched repeatedly without leaking old sources', () => {
    const made: ReturnType<typeof fakeSource>[] = [];
    const m = new SourceManager(SIM, (e) => events.push(e), () => {
      const f = fakeSource(`s${made.length}`);
      made.push(f);
      return f.source;
    });
    m.start();
    m.apply(BOARD);
    m.apply(SIM);
    m.apply(BOARD);
    expect(made).toHaveLength(4);
    // Everything except the current source is stopped.
    expect(made.slice(0, 3).every((f) => f.stopped)).toBe(true);
    expect(made[3]!.stopped).toBe(false);
  });
});

describe('source configuration', () => {
  it('describes each kind for the settings screen', async () => {
    const { describeSource } = await import('./sourceConfig.ts');
    expect(describeSource(SIM)).toBe('simulator');
    expect(describeSource(BOARD)).toBe('autodarts (http://192.168.1.5:3180)');
    expect(describeSource({ kind: 'replay', file: 'a.ndjson', speed: 2, loop: false }))
      .toBe('replay (a.ndjson at 2x)');
  });

  it('rejects a board url that is not a url', async () => {
    const { SourceConfigSchema } = await import('./sourceConfig.ts');
    expect(SourceConfigSchema.safeParse({ kind: 'autodarts', url: '192.168.1.5:3180' }).success)
      .toBe(false);
    expect(SourceConfigSchema.safeParse({ kind: 'autodarts', url: 'http://192.168.1.5:3180' }).success)
      .toBe(true);
  });

  it('reads the starting configuration from the environment', async () => {
    const { configFromEnv } = await import('./sourceConfig.ts');
    expect(configFromEnv({})).toEqual({ kind: 'simulator' });
    expect(configFromEnv({ SOURCE: 'autodarts', BOARD_URL: 'http://x:1' }))
      .toMatchObject({ kind: 'autodarts', url: 'http://x:1' });
    expect(configFromEnv({ SOURCE: 'replay', REPLAY_FILE: 'f.ndjson', REPLAY_SPEED: '4' }))
      .toMatchObject({ kind: 'replay', file: 'f.ndjson', speed: 4 });
  });
});
