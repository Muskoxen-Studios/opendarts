import { z } from 'zod';
import { segmentValue, type Ring, type Segment } from '@darts/schema';

/**
 * THE ANTI-CORRUPTION BOUNDARY.
 *
 * This is the only file in the repository that knows Autodarts field names.
 * Everything downstream depends on @darts/schema instead. When the real throw
 * payload is captured, this file changes and nothing else does.
 *
 * What is CONFIRMED (recon/FINDINGS.md):
 *   - transport, envelope {type, data}, channel names
 *   - `state.data.throws` is an array
 *   - each element has `coords` and `segment`, and segment has `name` and `bed`
 *   - bed is one of Single|SingleInner|SingleOuter|Double|Triple|Outside
 *
 * What is NOT yet confirmed, and is therefore parsed defensively:
 *   - whether `coords` is {x,y} or [x,y]; its units, origin and axis directions
 *   - whether `segment` also carries `number` / `multiplier`
 *   - whether `throws[]` is cumulative for the turn or reset per dart
 *
 * TODO(payload): settle the above from a real capture, then tighten this file.
 */

export class ThrowShapeError extends Error {
  readonly raw: unknown;
  constructor(message: string, raw: unknown) {
    super(
      `${message}\n` +
        `This means the board's throw payload does not match what was inferred ` +
        `from the UI bundle. Capture the raw frame and update ` +
        `packages/bridge/src/adapters/autodarts.ts.\n` +
        `Received: ${JSON.stringify(raw)?.slice(0, 400)}`,
    );
    this.name = 'ThrowShapeError';
    this.raw = raw;
  }
}

/**
 * Strict on purpose. A silent mis-parse would produce a plausible-but-wrong
 * score, which is far worse than a loud failure: it would corrupt the match and
 * the career statistics derived from it.
 */
const RawSegmentSchema = z.object({
  name: z.string(),
  bed: z.string(),
  number: z.number().optional(),
  multiplier: z.number().optional(),
});

const RawThrowSchema = z.object({
  segment: RawSegmentSchema,
  coords: z.unknown().optional(),
});

export type RawThrow = z.infer<typeof RawThrowSchema>;

const BED_TO_RING: Record<string, Ring> = {
  Single: 'SINGLE_OUTER',
  SingleInner: 'SINGLE_INNER',
  SingleOuter: 'SINGLE_OUTER',
  Double: 'DOUBLE',
  Triple: 'TRIPLE',
  Outside: 'MISS',
};

/** Extract the numeric part of a segment name such as "D20", "T5", "M18". */
function numberFromName(name: string): number | null {
  const m = /(\d{1,2})/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function toSegment(raw: unknown): Segment {
  const parsed = RawSegmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ThrowShapeError('Unrecognised segment object.', raw);
  }
  const { name, bed, number } = parsed.data;
  const upper = name.toUpperCase();

  // Bulls. The board may label these several ways, so accept the known set and
  // fail loudly on anything else rather than guessing.
  if (bed === 'Double' && (upper === 'DB' || upper === 'D25' || upper === 'BULL')) {
    return { number: 25, ring: 'BULL' };
  }
  if (upper === 'SB' || upper === 'S25' || upper === '25') {
    return { number: 25, ring: 'OUTER_BULL' };
  }
  if (upper === 'BULL' || upper === 'DBULL' || upper === '50') {
    return { number: 25, ring: 'BULL' };
  }

  // A dart outside the double ring scores nothing.
  if (bed === 'Outside' || upper.startsWith('M') || upper === 'OUT' || upper === 'MISS') {
    return { number: 0, ring: 'MISS' };
  }

  const ring = BED_TO_RING[bed];
  if (!ring) {
    throw new ThrowShapeError(`Unknown segment bed "${bed}".`, raw);
  }

  const n = number ?? numberFromName(name);
  if (n === null || n < 1 || n > 20) {
    throw new ThrowShapeError(`Could not read a segment number from "${name}".`, raw);
  }

  return { number: n, ring };
}

/**
 * Coordinates are accepted in either plausible shape but are NOT trusted.
 *
 * Returning null is always safe: no game logic, statistic or achievement may
 * depend on coordinates until their units and origin are known. Once that is
 * settled this becomes a real conversion and historical throws gain
 * coordinates through the normal backfill path.
 */
export function toCoords(_raw: unknown): { x: number; y: number } | null {
  // TODO(payload): units, origin and axis directions are unknown. Until a real
  // capture settles them, emitting a number here would invite downstream code
  // to depend on a value we cannot yet interpret.
  return null;
}

let seq = 0;

export function normalizeThrow(raw: unknown, ts: string = new Date().toISOString()) {
  const parsed = RawThrowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ThrowShapeError('Unrecognised throw object.', raw);
  }
  const segment = toSegment(parsed.data.segment);
  return {
    id: `ad-${ts}-${seq++}`,
    ts,
    segment,
    value: segmentValue(segment),
    coords: toCoords(parsed.data.coords),
    source: 'board' as const,
  };
}
