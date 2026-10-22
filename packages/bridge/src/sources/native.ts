import { BoardEventSchema, segmentValue, type BoardEvent } from '@darts/schema';
import type { EventSink, Source } from './types.ts';

export interface NativeOptions {
  baseUrl: string;
  heartbeatTimeoutMs?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/** Incremental SSE framing, including CR, LF, CRLF and split UTF-8 chunks. */
export class NativeSseParser {
  private decoder = new TextDecoder();
  private line = '';
  private skipLf = false;
  private data: string[] = [];
  private id = '';
  private size = 0;

  constructor(privateFrame: (id: string, data: string) => void, privateAlive: () => void) {
    this.frame = privateFrame;
    this.alive = privateAlive;
  }
  private frame: (id: string, data: string) => void;
  private alive: () => void;

  push(chunk: Uint8Array): void {
    for (const char of this.decoder.decode(chunk, { stream: true })) {
      if (this.skipLf) {
        this.skipLf = false;
        if (char === '\n') continue;
      }
      if (char === '\r' || char === '\n') {
        this.consumeLine();
        this.skipLf = char === '\r';
      } else {
        this.line += char;
        if (++this.size > 1_048_576) throw new Error('native SSE frame exceeds 1 MiB');
      }
    }
  }

  private consumeLine(): void {
    const line = this.line;
    this.line = '';
    if (line === '') {
      if (this.data.length) this.frame(this.id, this.data.join('\n'));
      this.data = [];
      this.id = '';
      this.size = 0;
      return;
    }
    if (line.startsWith(':')) {
      this.alive();
      // Heartbeats must not accumulate towards the event-size limit.
      this.size -= line.length;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') this.data.push(value);
    if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}

/** Detector events already speak our schema: never infer takeout from a reset. */
export function nativeSource(opts: NativeOptions): Source {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeout = opts.heartbeatTimeoutMs ?? 5000;
  const initialDelay = opts.reconnectDelayMs ?? 500;
  const maxDelay = opts.maxReconnectDelayMs ?? 15_000;
  let generation = 0;
  let controller: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let lastEventId = '';
  // High-water marks suppress replay even after a long visit; cap old sessions.
  const counters = new Map<string, number>();
  const throws = new Set<string>();

  const stop = (): void => {
    generation += 1;
    if (retry) clearTimeout(retry);
    if (watchdog) clearTimeout(watchdog);
    retry = watchdog = null;
    controller?.abort();
    controller = null;
  };

  return {
    name: 'native',
    stop,
    start(emit: EventSink) {
      stop();
      const run = generation;
      let delay = initialDelay;
      let resyncedStatus: BoardEvent | null = null;
      const active = (): boolean => run === generation;
      const connect = async (): Promise<void> => {
        if (!active()) return;
        const abort = new AbortController();
        controller = abort;
        let failure = 'native event stream closed';
        const alive = (resetBackoff = true): void => {
          if (!active()) return;
          if (resetBackoff) delay = initialDelay;
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            failure = 'native heartbeat timeout';
            abort.abort();
          }, timeout);
        };
        alive(false); // Bounds both connecting and a silent stream.
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await fetch(`${base}/events`, {
            headers: { Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
            signal: abort.signal,
          });
          if (!active()) { await response.body?.cancel(); return; }
          if (response.status === 409 && lastEventId) {
            await response.body?.cancel();
            // A detector restart or history eviction invalidates the cursor.
            // State can restore the indicator, never reconstruct missed throws.
            const snapshot = await fetch(`${base}/state`, { signal: abort.signal });
            if (!snapshot.ok) { await snapshot.body?.cancel(); throw new Error('native replay resync /state failed'); }
            const state = await snapshot.json() as { status?: unknown; running?: unknown };
            if (!active()) return;
            resyncedStatus = BoardEventSchema.parse({ type: 'board.status', status: state.status, running: state.running });
            lastEventId = '';
            failure = 'native replay history unavailable; resynced state; missed throws require operator reconciliation';
            console.error(`[bridge] ${failure}`);
            return;
          }
          if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
            await response.body?.cancel();
            throw new Error(`native /events returned ${response.status} without an SSE stream`);
          }
          emit({ type: 'board.connected' });
          if (resyncedStatus) { emit(resyncedStatus); resyncedStatus = null; }
          const parser = new NativeSseParser((id, data) => {
            if (!active()) return;
            const match = /^([^:\s]+):(\d+)$/.exec(id);
            if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('invalid native SSE event ID');
            const event = BoardEventSchema.parse(JSON.parse(data));
            if (event.type === 'throw.detected') {
              if (event.throw.source !== 'board' || !event.throw.id) throw new Error('native throws require stable board IDs');
              event.throw.value = segmentValue(event.throw.segment);
              // Native occupancy is authoritative: a fourth dart cannot stand in
              // for an observed takeout, even if the upstream omits this policy.
              event.allowTakeoutInference = false;
            }
            alive();
            const session = match[1]!;
            const counter = Number(match[2]);
            if (counter <= (counters.get(session) ?? -1)) return;
            counters.delete(session);
            counters.set(session, counter);
            if (counters.size > 64) counters.delete(counters.keys().next().value!);
            lastEventId = id;
            if (event.type === 'throw.detected') {
              if (throws.has(event.throw.id)) return;
              throws.add(event.throw.id);
              if (throws.size > 4096) throws.delete(throws.values().next().value!);
            }
            emit(event);
          }, () => {
            alive();
            if (active()) emit({ type: 'board.heartbeat' });
          });
          reader = response.body.getReader();
          while (active()) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (active()) parser.push(chunk.value);
          }
        } catch (err) {
          if (!abort.signal.aborted) failure = `native stream error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          abort.abort();
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
          if (active()) {
            if (watchdog) clearTimeout(watchdog);
            watchdog = null;
            controller = null;
            emit({ type: 'board.disconnected', reason: failure });
            retry = setTimeout(() => { void connect(); }, delay);
            delay = Math.min(delay * 2, maxDelay);
          }
        }
      };
      void connect();
    },
  };
}
