import { readFileSync } from 'node:fs';
import type { BoardEvent } from '@darts/schema';
import { normalizeThrow, ThrowShapeError } from '../adapters/autodarts.ts';
import type { EventSink, Source } from './types.ts';

export interface ReplayOptions {
  file: string;
  /** 1 = original timing, 10 = ten times faster, 0 = as fast as possible. */
  speed?: number;
  loop?: boolean;
}

interface RecordedLine {
  t: string;
  dir: string;
  data: { type?: string; data?: unknown };
}

/**
 * Replay source: feeds a recorded board capture back through the same adapter.
 *
 * The recon captures in recon/captures/*.ndjson are already in this format, and
 * the eventual real throw capture will be too -- which turns it into a
 * deterministic regression fixture the moment we have it.
 */
export function replaySource(opts: ReplayOptions): Source {
  const speed = opts.speed ?? 1;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const load = (): RecordedLine[] => {
    const raw = readFileSync(opts.file, 'utf8');
    const lines: RecordedLine[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as RecordedLine);
      } catch {
        // Skip malformed lines rather than aborting the whole replay.
      }
    }
    return lines;
  };

  const run = async (emit: EventSink): Promise<void> => {
    const lines = load();
    if (lines.length === 0) {
      console.warn(`[bridge] replay file ${opts.file} contained no usable frames`);
      return;
    }
    console.log(`[bridge] replaying ${lines.length} frames from ${opts.file}`);

    do {
      let previous: number | null = null;
      for (const line of lines) {
        if (stopped) return;
        const at = Date.parse(line.t);
        if (speed > 0 && previous !== null && Number.isFinite(at)) {
          const wait = Math.max(0, (at - previous) / speed);
          if (wait > 0) await new Promise((r) => { timer = setTimeout(r, wait); });
        }
        if (Number.isFinite(at)) previous = at;
        translate(line.data, emit);
      }
    } while (opts.loop && !stopped);
  };

  const translate = (frame: { type?: string; data?: unknown } | undefined, emit: EventSink): void => {
    if (!frame) return;
    if (frame.type === 'stats') {
      const d = frame.data as { fps?: number } | undefined;
      emit({ type: 'board.heartbeat', fps: d?.fps });
      return;
    }
    if (frame.type !== 'state') return;

    const data = frame.data as { status?: string; running?: boolean; throws?: unknown[] } | undefined;
    if (!data) return;
    if (data.status) {
      emit({
        type: 'board.status',
        status: data.status as BoardEvent extends { status: infer S } ? S : never,
        running: Boolean(data.running),
      } as BoardEvent);
    }
    for (const raw of data.throws ?? []) {
      try {
        emit({ type: 'throw.detected', throw: normalizeThrow(raw) });
      } catch (err) {
        if (err instanceof ThrowShapeError) console.error(err.message);
        else throw err;
      }
    }
  };

  return {
    name: 'replay',
    start(emit) {
      stopped = false;
      emit({ type: 'board.connected' });
      void run(emit);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
