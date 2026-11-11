import { describe, expect, it } from 'vitest';
import { BOARD_MM, SEGMENT_ORDER, type Segment } from '@darts/schema';
import { clientToBoardCoords, mmToSvg, segmentCentre, svgToMm } from './boardGeometry.ts';

describe('virtual board click coordinates', () => {
  // A square viewBox is centred inside the available element bounds. These
  // transforms include that padding, scrolling offsets and ancestor scaling.
  const layouts = [
    { name: 'square', a: 0.4, b: 0, c: 0, d: 0.4, e: 80, f: 120 },
    { name: 'wide with horizontal padding', a: 0.3, b: 0, c: 0, d: 0.3, e: 450, f: 90 },
    { name: 'tall with vertical padding', a: 0.3, b: 0, c: 0, d: 0.3, e: 60, f: 340 },
    { name: 'scaled and scrolled', a: 0.18, b: 0, c: 0, d: 0.18, e: 730, f: -65 },
    { name: 'rotated', a: 0.3, b: 0.04, c: -0.04, d: 0.3, e: 250, f: 70 },
  ];

  it.each(layouts)('keeps every scoring segment and marker aligned when $name', (screen) => {
    const segments: Segment[] = [
      { number: 25, ring: 'BULL' },
      { number: 25, ring: 'OUTER_BULL' },
      ...SEGMENT_ORDER.flatMap((number) =>
        (['SINGLE_INNER', 'TRIPLE', 'SINGLE_OUTER', 'DOUBLE'] as const)
          .map((ring) => ({ number, ring }))),
    ];
    for (const segment of segments) {
      const target = segmentCentre(segment);
      const click = {
        x: screen.a * target.x + screen.c * target.y + screen.e,
        y: screen.b * target.x + screen.d * target.y + screen.f,
      };
      const coords = clientToBoardCoords(click.x, click.y, screen)!;
      const plotted = mmToSvg(coords);
      expect(plotted.x).toBeCloseTo(target.x, 8);
      expect(plotted.y).toBeCloseTo(target.y, 8);
    }
  });

  it('accounts for horizontal letterboxing instead of stretching the click', () => {
    // An 800x400 element renders the board in the central 400x400 square.
    // Click 40px right and above its centre: 100 SVG units on each axis.
    const coords = clientToBoardCoords(540, 210, { a: 0.4, b: 0, c: 0, d: 0.4, e: 300, f: 50 });
    expect(coords!.x).toBeCloseTo(svgToMm(600, 400).x);
    expect(coords!.y).toBeCloseTo(svgToMm(500, 400).y);
  });

  it('preserves the board millimetres and upward y axis for an off-centre click', () => {
    const expected = { x: 31.5, y: BOARD_MM.TRIPLE_INNER + 2 };
    const target = mmToSvg(expected);
    const coords = clientToBoardCoords(target.x * 0.25 + 200, target.y * 0.25 + 100,
      { a: 0.25, b: 0, c: 0, d: 0.25, e: 200, f: 100 });
    expect(coords!.x).toBeCloseTo(expected.x);
    expect(coords!.y).toBeCloseTo(expected.y);
  });

  it('ignores clicks when the SVG transform is not invertible', () => {
    expect(clientToBoardCoords(50, 50, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBeNull();
  });
});
