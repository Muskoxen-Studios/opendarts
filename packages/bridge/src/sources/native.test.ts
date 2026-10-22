import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardEvent } from '@darts/schema';
import { NativeSseParser, nativeSource } from './native.ts';
import type { Source } from './types.ts';
import { SourceManager } from '../sourceManager.ts';
import { buildSource, configFromEnv, describeSource, SourceConfigSchema } from '../sourceConfig.ts';

const encoder = new TextEncoder();
const heartbeat = { type: 'board.heartbeat' } satisfies BoardEvent;
const dart = (id = 'stable-1'): BoardEvent => ({
  type: 'throw.detected',
  throw: { id, ts: '2026-01-01T00:00:00Z', segment: { number: 20, ring: 'TRIPLE' }, value: 1, coords: null, source: 'board' },
});
const frame = (id: string, event: unknown): string => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
const sources: Source[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) void source.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function transport() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_url: unknown, init: RequestInit) => {
    signals.push(init.signal!);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller);
        init.signal!.addEventListener('abort', () => {
          try { controller.error(new Error('aborted')); } catch { /* Already closed. */ }
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const send = (text: string, index = streams.length - 1): void => streams[index]!.enqueue(encoder.encode(text));
  return { streams, signals, fetchMock, send };
}
function start(options: Partial<Parameters<typeof nativeSource>[0]> = {}) {
  const events: BoardEvent[] = [];
  const source = nativeSource({ baseUrl: 'http://detector/', reconnectDelayMs: 5, ...options });
  sources.push(source);
  void source.start((event) => events.push(event));
  return { source, events };
}
const throwsOf = (events: BoardEvent[]) => events.filter((event) => event.type === 'throw.detected');

describe('native SSE framing', () => {
  it('handles byte-sized chunks, Unicode, CR/LF/CRLF, comments and optional field spaces', () => {
    const frames: unknown[] = [];
    const alive = vi.fn();
    const parser = new NativeSseParser((id, data) => frames.push({ id, data }), alive);
    const bytes = encoder.encode('\uFEFF: heartbeat\r\nid:s:1\rdata: {"text":"🎯"}\r\nid:ignored\r\rdata:one\ndata: two\n\n');
    for (const byte of bytes) parser.push(new Uint8Array([byte]));
    expect(alive).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{ id: 'ignored', data: '{"text":"🎯"}' }, { id: '', data: 'one\ntwo' }]);
  });
  it('does not dispatch incomplete events, ignores unknown fields and null-containing IDs', () => {
    const sink = vi.fn();
    const parser = new NativeSseParser(sink, () => {});
    parser.push(encoder.encode('event:message\nretry: 20\nid: s:1\nid: bad\0id\ndata: {}\n'));
    expect(sink).not.toHaveBeenCalled();
    parser.push(encoder.encode('\n'));
    expect(sink).toHaveBeenCalledWith('s:1', '{}');
  });
  it('bounds incomplete frames but allows ongoing comments', () => {
    const parser = new NativeSseParser(() => {}, () => {});
    for (let i = 0; i < 1100; i++) parser.push(encoder.encode(`:${'a'.repeat(1000)}\n`));
    expect(() => parser.push(encoder.encode('a'.repeat(1_048_577)))).toThrow('1 MiB');
  });
});

describe('native source', () => {
  it('validates BoardEvents, preserves board IDs/nullable coords and recomputes score', async () => {
    const wire = transport();
    const { events, source } = start();
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'board.connected' }));
    wire.send(frame('session:1', dart()));
    await vi.waitFor(() => expect(throwsOf(events)).toHaveLength(1));
    expect(throwsOf(events)[0]).toEqual({ ...dart(), allowTakeoutInference: false, throw: { ...(dart() as Extract<BoardEvent, { type: 'throw.detected' }>).throw, value: 60 } });
    expect(source.inject).toBeUndefined();
    expect(wire.fetchMock.mock.calls[0]![0]).toBe('http://detector/events');
  });
  it('disables legacy takeout inference even if upstream requests it', async () => {
    const wire = transport();
    const { events } = start();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    wire.send(frame('session:1', { ...dart(), allowTakeoutInference: true }));
    await vi.waitFor(() => expect(throwsOf(events)).toHaveLength(1));
    expect(throwsOf(events)[0]).toMatchObject({ allowTakeoutInference: false });
  });
  it('deduplicates replay and stable throw IDs, reconnecting with Last-Event-ID', async () => {
    const wire = transport();
    const { events } = start();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    wire.send(frame('session:1', dart()) + frame('session:2', heartbeat));
    await vi.waitFor(() => expect(throwsOf(events)).toHaveLength(1));
    wire.streams[0]!.close();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(2));
    expect(wire.fetchMock.mock.calls[1]![1].headers).toMatchObject({ 'Last-Event-ID': 'session:2' });
    wire.send(frame('session:1', dart()) + frame('session:3', dart()) + frame('session:4', dart('stable-2')));
    await vi.waitFor(() => expect(throwsOf(events)).toHaveLength(2));
    wire.streams[1]!.close();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(3));
    expect(wire.fetchMock.mock.calls[2]![1].headers).toMatchObject({ 'Last-Event-ID': 'session:4' });
  });
  it('resyncs expired replay history through /state and reconnects without a stale cursor', async () => {
    const wire = transport();
    const { events } = start();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    wire.send(frame('old:1', dart()));
    await vi.waitFor(() => expect(throwsOf(events)).toHaveLength(1));
    wire.fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{"error":"history unavailable"}', { status: 409 })))
      .mockImplementationOnce(() => Promise.resolve(new Response('{"running":true,"status":"Throw"}')));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire.streams[0]!.close();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(2));
    expect(wire.fetchMock.mock.calls[2]![0]).toBe('http://detector/state');
    expect(wire.fetchMock.mock.calls[3]![1].headers).not.toHaveProperty('Last-Event-ID');
    expect(events).toContainEqual({ type: 'board.status', status: 'Throw', running: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('operator reconciliation'));
    expect(throwsOf(events)).toHaveLength(1);
  });
  it('allows new session counters to restart without repeating prior sessions', async () => {
    const wire = transport();
    const { events } = start();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    wire.send(frame('old:100', dart('a')) + frame('new:0', dart('b')) + frame('old:99', dart('c')));
    await vi.waitFor(() => expect(throwsOf(events)).toHaveLength(2));
  });
  it.each([
    ['missing ID', 'data: {"type":"board.heartbeat"}\n\n'],
    ['malformed JSON', 'id: s:1\ndata: nope\n\n'],
    ['invalid schema', frame('s:1', { type: 'board.status', status: 'unknown', running: true })],
    ['non-board throw', frame('s:1', { ...dart(), throw: { ...(dart() as Extract<BoardEvent, { type: 'throw.detected' }>).throw, source: 'manual' } })],
  ])('disconnects loudly on %s without advancing replay cursor', async (_name, data) => {
    const wire = transport();
    const { events } = start();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    wire.send(data);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'board.disconnected' && event.reason?.includes('native stream error'))).toBe(true));
    await vi.waitFor(() => expect(wire.streams.length).toBeGreaterThan(1));
    expect(wire.fetchMock.mock.calls[1]![1].headers).not.toHaveProperty('Last-Event-ID');
    expect(throwsOf(events)).toHaveLength(0);
  });
  it.each([
    [503, 'application/json'],
    [200, 'application/json'],
  ])('rejects unusable SSE responses (%i, %s) and retries', async (status, contentType) => {
    const wire = transport();
    wire.fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status, headers: { 'content-type': contentType } })));
    const { events } = start();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'board.disconnected' && event.reason?.includes('without an SSE stream'))).toBe(true));
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    expect(wire.fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reset-related status events never synthesize a takeout', async () => {
    const wire = transport();
    const { source, events } = start();
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    source.noteCounterReset?.();
    wire.send(frame('s:1', dart()) + frame('s:2', { type: 'board.status', running: true, status: 'Starting' })
      + frame('s:3', { type: 'board.status', running: true, status: 'Throw' }));
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'board.status', running: true, status: 'Throw' }));
    expect(events.some((event) => event.type.startsWith('takeout.'))).toBe(false);
  });
  it('times out silent streams, aborts and reconnects', async () => {
    const wire = transport();
    const { events } = start({ heartbeatTimeoutMs: 30 });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'board.disconnected', reason: 'native heartbeat timeout' }));
    expect(wire.signals[0]!.aborted).toBe(true);
    await vi.waitFor(() => expect(wire.streams.length).toBeGreaterThan(1));
  });
  it('comment heartbeats keep an otherwise idle connection alive', async () => {
    const wire = transport();
    const { events } = start({ heartbeatTimeoutMs: 200 });
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    for (let i = 0; i < 5; i++) {
      wire.send(': heartbeat\n\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(wire.streams).toHaveLength(1);
    expect(events.filter((event) => event.type === 'board.heartbeat')).toHaveLength(5);
  });
  it('bounds a fetch that never returns headers', async () => {
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { events } = start({ heartbeatTimeoutMs: 20 });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'board.disconnected', reason: 'native heartbeat timeout' }));
  });
  it('stop cancels retry timers and does not emit late disconnects', async () => {
    const wire = transport();
    const { events, source } = start({ reconnectDelayMs: 100 });
    await vi.waitFor(() => expect(wire.streams).toHaveLength(1));
    wire.streams[0]!.close();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'board.disconnected')).toBe(true));
    void source.stop();
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wire.streams).toHaveLength(1);
    expect(events).toHaveLength(count);
  });
  it('guards a late fetch completion after switching sources', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const events: BoardEvent[] = [];
    const manager = new SourceManager({ kind: 'native', url: 'http://detector' }, (event) => events.push(event));
    manager.start();
    manager.apply({ kind: 'simulator' });
    events.length = 0;
    resolve(new Response(frame('s:1', dart()), { headers: { 'content-type': 'text/event-stream' } }));
    await new Promise((done) => setTimeout(done, 20));
    expect(events).toEqual([]);
    manager.stop();
  });
});

describe('native configuration', () => {
  it('defaults runtime and environment URLs and describes the source', () => {
    const config = { kind: 'native', url: 'http://127.0.0.1:8091' } as const;
    expect(SourceConfigSchema.parse({ kind: 'native' })).toEqual(config);
    expect(configFromEnv({ SOURCE: 'NATIVE' })).toEqual(config);
    expect(configFromEnv({ SOURCE: 'native', DETECTOR_URL: 'http://detector:9', BOARD_URL: 'http://fallback:8' })).toEqual({ kind: 'native', url: 'http://detector:9' });
    expect(configFromEnv({ SOURCE: 'native', BOARD_URL: 'http://fallback:8' })).toEqual({ kind: 'native', url: 'http://fallback:8' });
    expect(describeSource(config)).toBe('native detector (http://127.0.0.1:8091)');
    expect(buildSource(config).inject).toBeUndefined();
    expect(SourceConfigSchema.safeParse({ kind: 'native', url: 'ftp://detector' }).success).toBe(false);
    expect(SourceConfigSchema.safeParse({ kind: 'native', url: 'not a URL' }).success).toBe(false);
  });
});
