import { z } from 'zod';
import { BOARD_NORM, segmentValue, type Ring, type Segment } from '@darts/schema';

/**
 * THE ANTI-CORRUPTION BOUNDARY.
 *
 * This is the only file in the repository that knows Autodarts field names.
 * Everything downstream depends on @darts/schema instead.
 *
 * What is CONFIRMED, against a real board (recon/FINDINGS.md §3):
 *   - transport, envelope {type, data}, channel names
 *   - `state.data.throws` is an array, cumulative for the current visit to the
 *     board -- it grows by one element per dart rather than resetting
 *   - each element has `coords: {x, y}` and `segment: {name, bed, number,
 *     multiplier}`
 *   - `coords` is normalised by 170 (board millimetres / 170), origin at the
 *     bull, x right, y **up** -- the same orientation as our own `Coords`
 *   - `multiplier` is present but unused here: the ring is derived from `bed`,
 *     which is confirmed and does not need it
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

const RawCoordsSchema = z.object({ x: z.number(), y: z.number() });

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
 * Board coordinates are `{x, y}`, normalised by 170 (board millimetres / 170),
 * origin at the bull, x right, y **up** -- confirmed against a real board,
 * recon/FINDINGS.md §3.
 *
 * That is the same orientation as `@darts/schema`'s `Coords` (board
 * millimetres, x right, y up -- what a person would draw on paper, see
 * boardGeometry.ts), so both axes pass straight through and the only thing
 * this does is scale by 170.
 *
 * It used to negate y, on the inference that the board used the screen
 * convention. It does not, and the darts came out mirrored top-to-bottom --
 * a dart at 20 plotted at 3. See §3 of FINDINGS for how that was missed.
 *
 * Still returns null on anything that doesn't parse: a malformed `coords`
 * should not take the whole throw down with it, since the segment alone is
 * enough to score.
 */
export function toCoords(raw: unknown): { x: number; y: number } | null {
  const parsed = RawCoordsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { x: parsed.data.x * BOARD_NORM, y: parsed.data.y * BOARD_NORM };
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
