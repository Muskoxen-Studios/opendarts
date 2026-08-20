import {
  BOARD_MM,
  BOARD_NORM,
  SEGMENT_ANGLE,
  SEGMENT_ORDER,
  type Segment,
} from '@darts/schema';

/**
 * THE MIRROR IMAGE of packages/bridge/src/adapters/autodarts.ts.
 *
 * That file is the only one in the repository that *reads* Autodarts field
 * names; this is the only one that *writes* them. Everything else in this
 * package speaks @darts/schema.
 *
 * What this file emits was originally inferred from the board UI's minified
 * bundle, before a real board was captured. `recon/FINDINGS.md` §3 now confirms
 * it against `recon/captures/live-ws-2026-08-20T10-06-03-291Z.ndjson`: this
 * file's shape and coordinate formula matched the real board within noise, so
 * nothing here needed to change.
 */

/** `segment.bed`, per FINDINGS §3. */
export type Bed = 'Single' | 'SingleInner' | 'SingleOuter' | 'Double' | 'Triple' | 'Outside';

export interface RawSegment {
  name: string;
  bed: Bed;
}

export interface RawThrow {
  segment: RawSegment;
  coords: { x: number; y: number };
}

/**
 * A 1-character prefix plus the number, e.g. "S11" — confirmed by a real
 * capture (FINDINGS §3), matching what the UI's `segment.name.slice(1,5)`
 * implied.
 */
function name(prefix: string, number: number): string {
  return `${prefix}${number}`;
}

export function toRawSegment(segment: Segment): RawSegment {
  switch (segment.ring) {
    case 'BULL':
      // ASSUMED: bull as bed "Double" named "DB". The adapter also accepts
      // "D25" and "BULL", so a real board disagreeing here still scores.
      return { name: 'DB', bed: 'Double' };
    case 'OUTER_BULL':
      return { name: 'SB', bed: 'Single' };
    case 'MISS':
      // The miss ring is reported per number ("M20"). Our Segment collapses
      // every miss to number 0, so the number here is cosmetic — the adapter
      // reads the bed and stops.
      return { name: name('M', segment.number > 0 ? segment.number : 20), bed: 'Outside' };
    case 'DOUBLE':
      return { name: name('D', segment.number), bed: 'Double' };
    case 'TRIPLE':
      return { name: name('T', segment.number), bed: 'Triple' };
    case 'SINGLE_INNER':
      return { name: name('S', segment.number), bed: 'SingleInner' };
    case 'SINGLE_OUTER':
      return { name: name('S', segment.number), bed: 'SingleOuter' };
  }
}

/** Middle of the ring's radial band, in board millimetres from the centre. */
function radiusMm(segment: Segment): number {
  switch (segment.ring) {
    case 'BULL':
      return 0;
    case 'OUTER_BULL':
      return (BOARD_MM.BULL_INNER + BOARD_MM.BULL_OUTER) / 2;
    case 'SINGLE_INNER':
      return (BOARD_MM.BULL_OUTER + BOARD_MM.TRIPLE_INNER) / 2;
    case 'TRIPLE':
      return (BOARD_MM.TRIPLE_INNER + BOARD_MM.TRIPLE_OUTER) / 2;
    case 'SINGLE_OUTER':
      return (BOARD_MM.TRIPLE_OUTER + BOARD_MM.DOUBLE_INNER) / 2;
    case 'DOUBLE':
      return (BOARD_MM.DOUBLE_INNER + BOARD_MM.DOUBLE_OUTER) / 2;
    case 'MISS':
      return (BOARD_MM.DOUBLE_OUTER + BOARD_MM.BOARD_OUTER) / 2;
  }
}

/**
 * `{x, y}`, normalised by 170 (the divisor the UI bundle uses for its own
 * radii), origin at the bull, x right, y **down** — screen convention.
 * Confirmed by a real capture (FINDINGS §3): the same three darts landed
 * within noise of what this formula predicts for their segment.
 */
export function toRawCoords(segment: Segment): { x: number; y: number } {
  const r = radiusMm(segment) / BOARD_NORM;
  if (r === 0) return { x: 0, y: 0 };

  const index = SEGMENT_ORDER.indexOf(segment.number as (typeof SEGMENT_ORDER)[number]);
  // A bull or a miss has no meaningful segment angle; put it straight up so the
  // value stays deterministic rather than arbitrary.
  const theta = ((index < 0 ? 0 : index * SEGMENT_ANGLE) * Math.PI) / 180;

  return {
    x: round(r * Math.sin(theta)),
    y: round(-r * Math.cos(theta)),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Build the raw throw object the board would put in `state.data.throws`. */
export function toRawThrow(segment: Segment): RawThrow {
  return { segment: toRawSegment(segment), coords: toRawCoords(segment) };
}
