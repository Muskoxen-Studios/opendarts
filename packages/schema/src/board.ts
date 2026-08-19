/**
 * Standard dartboard geometry.
 *
 * Radii are in millimetres and match the BDO/WDF spec. These values were
 * cross-checked against the constants embedded in the Autodarts board UI bundle
 * (see recon/FINDINGS.md §5), which normalises them by 170.
 */
export const BOARD_MM = {
  BULL_INNER: 7,
  BULL_OUTER: 17,
  TRIPLE_INNER: 97,
  TRIPLE_OUTER: 107,
  DOUBLE_INNER: 160,
  DOUBLE_OUTER: 170,
  /** Outer edge of the board surface, beyond the double ring. */
  BOARD_OUTER: 225,
} as const;

/** Normalisation divisor used by the Autodarts UI: radii / 170. */
export const BOARD_NORM = 170;

/**
 * Segment numbers in clockwise order starting at 20 (which sits at the top).
 * Index 0 is centred on the 12 o'clock position.
 */
export const SEGMENT_ORDER = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
] as const;

/** Angular width of one segment, in degrees. */
export const SEGMENT_ANGLE = 360 / SEGMENT_ORDER.length;

/**
 * Which ring a dart landed in.
 *
 * `SINGLE_INNER` and `SINGLE_OUTER` are tracked separately because the board
 * reports them distinctly, and because accuracy statistics care about the
 * difference. Both score the same.
 */
export type Ring =
  | 'MISS'
  | 'SINGLE_INNER'
  | 'SINGLE_OUTER'
  | 'DOUBLE'
  | 'TRIPLE'
  | 'OUTER_BULL'
  | 'BULL';

export const RINGS: readonly Ring[] = [
  'MISS',
  'SINGLE_INNER',
  'SINGLE_OUTER',
  'DOUBLE',
  'TRIPLE',
  'OUTER_BULL',
  'BULL',
];

export interface Segment {
  /** 1..20 for numbered segments, 25 for either bull, 0 for a miss. */
  number: number;
  ring: Ring;
}

/** Points scored by a segment. */
export function segmentValue(segment: Segment): number {
  switch (segment.ring) {
    case 'MISS':
      return 0;
    case 'BULL':
      return 50;
    case 'OUTER_BULL':
      return 25;
    case 'DOUBLE':
      return segment.number * 2;
    case 'TRIPLE':
      return segment.number * 3;
    case 'SINGLE_INNER':
    case 'SINGLE_OUTER':
      return segment.number;
  }
}

/** How many marks this segment scores in Cricket (bull counts as one target). */
export function segmentMarks(segment: Segment): number {
  switch (segment.ring) {
    case 'MISS':
      return 0;
    case 'BULL':
      return 2;
    case 'OUTER_BULL':
      return 1;
    case 'DOUBLE':
      return 2;
    case 'TRIPLE':
      return 3;
    case 'SINGLE_INNER':
    case 'SINGLE_OUTER':
      return 1;
  }
}

/** Compact human label, e.g. "T20", "D16", "BULL", "25", "MISS". */
export function segmentLabel(segment: Segment): string {
  switch (segment.ring) {
    case 'MISS':
      return 'MISS';
    case 'BULL':
      return 'BULL';
    case 'OUTER_BULL':
      return '25';
    case 'DOUBLE':
      return `D${segment.number}`;
    case 'TRIPLE':
      return `T${segment.number}`;
    default:
      return `S${segment.number}`;
  }
}

/**
 * Inverse of `segmentLabel`: turn a compact label back into a segment.
 *
 * Returns null rather than throwing, because the callers are display code --
 * the scoreboard turning a checkout hint into a board highlight -- and a label
 * it cannot parse should simply light nothing up.
 */
export function parseSegmentLabel(label: string): Segment | null {
  const s = label.trim().toUpperCase();
  if (s === 'MISS') return { number: 0, ring: 'MISS' };
  if (s === 'BULL' || s === 'D25' || s === '50') return { number: 25, ring: 'BULL' };
  if (s === '25' || s === 'SB') return { number: 25, ring: 'OUTER_BULL' };

  const m = /^([TDS]?)(\d{1,2})$/.exec(s);
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isInteger(number) || number < 1 || number > 20) return null;
  if (m[1] === 'T') return { number, ring: 'TRIPLE' };
  if (m[1] === 'D') return { number, ring: 'DOUBLE' };
  return { number, ring: 'SINGLE_OUTER' };
}

/** True if the segment is a valid finishing dart for a double-out rule. */
export function isDouble(segment: Segment): boolean {
  return segment.ring === 'DOUBLE' || segment.ring === 'BULL';
}

/**
 * True if the segment counts as a "master" shot (double, triple, or bull),
 * used by master-in / master-out rules.
 */
export function isMaster(segment: Segment): boolean {
  return (
    segment.ring === 'DOUBLE' ||
    segment.ring === 'TRIPLE' ||
    segment.ring === 'BULL'
  );
}

export const MISS: Segment = { number: 0, ring: 'MISS' };
