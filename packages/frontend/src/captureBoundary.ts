import { BOARD_MM, SEGMENT_ANGLE, type Coords } from '@darts/schema';

const SCORING_RADII = [
  BOARD_MM.BULL_INNER,
  BOARD_MM.BULL_OUTER,
  BOARD_MM.TRIPLE_INNER,
  BOARD_MM.TRIPLE_OUTER,
  BOARD_MM.DOUBLE_INNER,
  BOARD_MM.DOUBLE_OUTER,
];

/** Distance in millimetres to the nearest scoring boundary (ring circle or wedge wire). */
export function distanceToScoringBoundary(point: Coords): number {
  const radius = Math.hypot(point.x, point.y);
  let nearest = Math.min(...SCORING_RADII.map(boundary => Math.abs(radius - boundary)));

  // The 20 wedge is centred at 90 degrees; its first edge is at 81 degrees.
  // Wires only span the scoring face, from the outer bull to the double outer.
  for (let i = 0; i < 20; i += 1) {
    const angle = (81 + i * SEGMENT_ANGLE) * Math.PI / 180;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const projection = Math.max(BOARD_MM.BULL_OUTER, Math.min(BOARD_MM.DOUBLE_OUTER, point.x * ux + point.y * uy));
    nearest = Math.min(nearest, Math.hypot(point.x - projection * ux, point.y - projection * uy));
  }
  return nearest;
}

/** Null/non-finite positions are never eligible for automatic filtering. */
export function isNearScoringBoundary(point: Coords | null | undefined, thresholdMm: number): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    distanceToScoringBoundary(point) <= thresholdMm;
}
