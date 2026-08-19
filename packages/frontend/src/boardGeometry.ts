import { BOARD_MM, SEGMENT_ORDER, type Coords, type Ring, type Segment } from '@darts/schema';

/**
 * Dartboard geometry, shared by everything that draws a board.
 *
 * The virtual board and the heatmap have to agree down to the pixel: a dart
 * plotted at the coordinates the board was clicked at must land back inside the
 * wedge it scored. Keeping the maths in one place is what guarantees that.
 */

export const SIZE = 1000;
export const C = SIZE / 2;

/**
 * The number ring sits outside the board surface, so the board cannot fill the
 * viewBox. Size it from the glyph box rather than the font size: a two-digit
 * number is wider than it is tall, so the numbers at 3 and 9 o'clock are the
 * ones that clip first.
 */
export const NUMBER_FONT = 46;
/** Half the widest glyph box ("20" at 46px), used as the clearance radius. */
const NUMBER_HALF = 30;
const EDGE_MARGIN = 8;
/** Distance from centre to the middle of a number. */
export const NUMBER_RADIUS = SIZE / 2 - EDGE_MARGIN - NUMBER_HALF;
export const BOARD_RADIUS = NUMBER_RADIUS - NUMBER_HALF - 6;
const SCALE = BOARD_RADIUS / BOARD_MM.BOARD_OUTER;

/** Board millimetres to SVG units. */
export const r = (mm: number): number => mm * SCALE;

export const SEGMENT_SWEEP = 360 / SEGMENT_ORDER.length;

export function polar(radius: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [C + radius * Math.cos(rad), C + radius * Math.sin(rad)];
}

/** Path for the band between two radii, spanning an angular sector. */
export function band(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${x0} ${y0}`,
    `A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3}`,
    'Z',
  ].join(' ');
}

export interface BoardCell {
  d: string;
  segment: Segment;
  /** Alternating sector shading, as on a real board. */
  dark: boolean;
  label: string;
}

/**
 * Every clickable band of the board, bulls excluded.
 *
 * Bulls are circles rather than sectors, so each component draws those itself.
 */
export function boardCells(): BoardCell[] {
  const out: BoardCell[] = [];
  const half = SEGMENT_SWEEP / 2;

  SEGMENT_ORDER.forEach((number, i) => {
    // 20 sits at the top, so sector centres start at -90 degrees.
    const centre = -90 + i * SEGMENT_SWEEP;
    const a0 = centre - half;
    const a1 = centre + half;
    const dark = i % 2 === 1;

    const rings: Array<{ ring: Ring; r0: number; r1: number }> = [
      { ring: 'MISS', r0: r(BOARD_MM.DOUBLE_OUTER), r1: r(BOARD_MM.BOARD_OUTER) },
      { ring: 'DOUBLE', r0: r(BOARD_MM.DOUBLE_INNER), r1: r(BOARD_MM.DOUBLE_OUTER) },
      { ring: 'SINGLE_OUTER', r0: r(BOARD_MM.TRIPLE_OUTER), r1: r(BOARD_MM.DOUBLE_INNER) },
      { ring: 'TRIPLE', r0: r(BOARD_MM.TRIPLE_INNER), r1: r(BOARD_MM.TRIPLE_OUTER) },
      { ring: 'SINGLE_INNER', r0: r(BOARD_MM.BULL_OUTER), r1: r(BOARD_MM.TRIPLE_INNER) },
    ];

    for (const b of rings) {
      out.push({
        d: band(b.r0, b.r1, a0, a1),
        dark,
        segment: { number: b.ring === 'MISS' ? 0 : number, ring: b.ring },
        label: b.ring === 'MISS' ? 'Miss' : `${b.ring} ${number}`,
      });
    }
  });

  return out;
}

export const NUMBERS = SEGMENT_ORDER.map((number, i) => {
  const centre = -90 + i * SEGMENT_SWEEP;
  const [x, y] = polar(NUMBER_RADIUS, centre);
  return { number, x, y };
});

export const BULL_OUTER_R = r(BOARD_MM.BULL_OUTER);
export const BULL_INNER_R = r(BOARD_MM.BULL_INNER);

/**
 * Coordinates are board millimetres from the centre, x to the right and y
 * upwards -- the orientation a person would draw on paper. SVG's y grows
 * downwards, hence the flip here and only here.
 */
export function mmToSvg(c: Coords): { x: number; y: number } {
  return { x: C + r(c.x), y: C - r(c.y) };
}

export function svgToMm(x: number, y: number): Coords {
  return { x: (x - C) / (BOARD_RADIUS / BOARD_MM.BOARD_OUTER), y: (C - y) / (BOARD_RADIUS / BOARD_MM.BOARD_OUTER) };
}

/** Where a segment's centre sits, used to anchor a marker on a labelled dart. */
export function segmentCentre(segment: Segment): { x: number; y: number } {
  if (segment.ring === 'BULL') return { x: C, y: C };
  if (segment.ring === 'OUTER_BULL') return { x: C, y: C - (BULL_INNER_R + BULL_OUTER_R) / 2 };
  const index = SEGMENT_ORDER.indexOf(segment.number as (typeof SEGMENT_ORDER)[number]);
  if (index < 0) return { x: C, y: C };
  const angle = -90 + index * SEGMENT_SWEEP;
  const radius = {
    MISS: r((BOARD_MM.DOUBLE_OUTER + BOARD_MM.BOARD_OUTER) / 2),
    DOUBLE: r((BOARD_MM.DOUBLE_INNER + BOARD_MM.DOUBLE_OUTER) / 2),
    TRIPLE: r((BOARD_MM.TRIPLE_INNER + BOARD_MM.TRIPLE_OUTER) / 2),
    SINGLE_OUTER: r((BOARD_MM.TRIPLE_OUTER + BOARD_MM.DOUBLE_INNER) / 2),
    SINGLE_INNER: r((BOARD_MM.BULL_OUTER + BOARD_MM.TRIPLE_INNER) / 2),
    OUTER_BULL: BULL_OUTER_R,
    BULL: 0,
  }[segment.ring];
  const [x, y] = polar(radius, angle);
  return { x, y };
}
