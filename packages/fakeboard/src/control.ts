import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseSegmentLabel, SegmentSchema, type Segment } from '@darts/schema';
import type { FakeBoard } from './board.ts';
import { json } from './http.ts';

/**
 * The driving surface: how a test or a human makes darts happen.
 *
 * Namespaced under /sim, never /api, so nothing here can ever be mistaken for
 * a real board endpoint — including by the recon scripts, which probe /api.
 */

export interface ControlDeps {
  board: FakeBoard;
  /** Drop every websocket and refuse new ones for `ms`. */
  disconnect(ms: number): void;
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

/**
 * Accepts either a full segment object or a compact label, so a dart can be
 * thrown with `curl -d '{"segment":"T20"}'` rather than by hand-writing JSON.
 */
function parseSegment(raw: unknown): Segment | null {
  if (typeof raw === 'string') return parseSegmentLabel(raw);
  const parsed = SegmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns true if it handled the request. */
export async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlDeps,
): Promise<boolean> {
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith('/sim')) return false;

  if (req.method !== 'POST') {
    json(res, 405, { error: 'the /sim endpoints are all POST' });
    return true;
  }

  const body = (await readBody(req)) as Record<string, unknown> | null;
  if (body === null) {
    json(res, 400, { error: 'body was not valid JSON' });
    return true;
  }

  if (url === '/sim/throw') {
    const segment = parseSegment(body.segment);
    if (!segment) {
      json(res, 400, { error: 'expected { segment: "T20" } or { segment: { number, ring } }' });
      return true;
    }
    if (!deps.board.running) {
      json(res, 409, { error: 'detection is stopped; PUT /api/start first' });
      return true;
    }
    deps.board.throwDart(segment);
    json(res, 202, board(deps));
    return true;
  }

  if (url === '/sim/takeout') {
    deps.board.takeoutStart();
    deps.board.takeoutComplete();
    json(res, 202, board(deps));
    return true;
  }

  if (url === '/sim/turn') {
    const raw = Array.isArray(body.segments) ? body.segments : null;
    const segments = raw?.map(parseSegment);
    if (!segments || segments.some((s) => s === null)) {
      json(res, 400, { error: 'expected { segments: ["T20", "T20", "T20"] }' });
      return true;
    }
    if (!deps.board.running) {
      json(res, 409, { error: 'detection is stopped; PUT /api/start first' });
      return true;
    }
    // Defaults to no delay so tests stay fast and deterministic; pass gapMs to
    // watch a turn land at human speed in the UI.
    const gapMs = typeof body.gapMs === 'number' ? Math.max(0, Math.min(body.gapMs, 10_000)) : 0;
    for (const segment of segments) {
      if (gapMs) await sleep(gapMs);
      deps.board.throwDart(segment as Segment);
    }
    if (gapMs) await sleep(gapMs);
    deps.board.takeoutStart();
    if (gapMs) await sleep(gapMs);
    deps.board.takeoutComplete();
    json(res, 202, board(deps));
    return true;
  }

  if (url === '/sim/disconnect') {
    const ms = typeof body.ms === 'number' ? Math.max(0, Math.min(body.ms, 60_000)) : 1000;
    deps.disconnect(ms);
    json(res, 202, { ok: true, ms });
    return true;
  }

  json(res, 404, { error: `no such control endpoint: ${url}` });
  return true;
}

function board(deps: ControlDeps) {
  return { ok: true, state: deps.board.snapshot() };
}
