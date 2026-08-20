import { describe, it, expect } from 'vitest';
import { toRawCoords } from '@darts/fakeboard';
import { SEGMENT_ANGLE, SEGMENT_ORDER, type Segment } from '@darts/schema';
import { normalizeThrow, toCoords, toSegment, ThrowShapeError } from './autodarts.ts';

describe('segment translation', () => {
  it('maps the bed enum onto our rings', () => {
    expect(toSegment({ name: 'T20', bed: 'Triple' })).toEqual({ number: 20, ring: 'TRIPLE' });
    expect(toSegment({ name: 'D16', bed: 'Double' })).toEqual({ number: 16, ring: 'DOUBLE' });
    expect(toSegment({ name: 'S5', bed: 'SingleInner' })).toEqual({ number: 5, ring: 'SINGLE_INNER' });
    expect(toSegment({ name: 'S5', bed: 'SingleOuter' })).toEqual({ number: 5, ring: 'SINGLE_OUTER' });
  });

  it('treats a dart outside the double ring as a miss', () => {
    expect(toSegment({ name: 'M20', bed: 'Outside' })).toEqual({ number: 0, ring: 'MISS' });
  });

  it('recognises both bulls', () => {
    expect(toSegment({ name: 'DB', bed: 'Double' })).toEqual({ number: 25, ring: 'BULL' });
    expect(toSegment({ name: '25', bed: 'Single' })).toEqual({ number: 25, ring: 'OUTER_BULL' });
  });

  it('prefers an explicit number field when present', () => {
    expect(toSegment({ name: 'weird', bed: 'Triple', number: 19 })).toEqual({
      number: 19,
      ring: 'TRIPLE',
    });
  });
});

describe('failing loudly on an unexpected payload', () => {
  it('rejects an unknown bed rather than guessing', () => {
    expect(() => toSegment({ name: 'X20', bed: 'Quadruple' })).toThrow(ThrowShapeError);
  });

  it('rejects a segment with no readable number', () => {
    expect(() => toSegment({ name: 'nonsense', bed: 'Triple' })).toThrow(ThrowShapeError);
  });

  it('rejects a completely foreign object', () => {
    expect(() => normalizeThrow({ score: 60 })).toThrow(ThrowShapeError);
  });

  it('names the offending payload in the error, so the adapter can be fixed', () => {
    try {
      toSegment({ name: 'T20', bed: 'Sextuple' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('Sextuple');
      expect(String(err)).toContain('adapters/autodarts.ts');
    }
  });
});

describe('coordinates', () => {
  it('scales by 170 and leaves both axes alone', () => {
    expect(toCoords({ x: 0.5, y: 0.25 })).toEqual({ x: 85, y: 42.5 });
  });

  /*
   * The axis direction, stated as intent rather than as a number.
   *
   * This is the assertion that was missing: the board's y points up, like our
   * own Coords, and negating it mirrored every dart top-to-bottom -- 20 came
   * out at 3. A raw dart in the top half has to stay in the top half.
   */
  it('keeps a dart in the half of the board it was thrown into', () => {
    expect(toCoords({ x: 0, y: 0.9 })!.y).toBeGreaterThan(0);
    expect(toCoords({ x: 0, y: -0.9 })!.y).toBeLessThan(0);
    expect(toCoords({ x: 0.9, y: 0 })!.x).toBeGreaterThan(0);
  });

  /*
   * The three darts of the real capture (FINDINGS §3), which is what settled
   * the direction: S4 and S1 both sit in the upper right of the board and both
   * were reported with a positive y.
   */
  it('plots the real capture where those darts actually landed', () => {
    expect(toCoords({ x: 0.5476268779047749, y: 0.33845423262136143 })!.y).toBeGreaterThan(0);
    expect(toCoords({ x: 0.18832737995641766, y: 0.37901887299768106 })!.y).toBeGreaterThan(0);
  });

  it('is null for anything that does not parse as {x, y}', () => {
    expect(toCoords([1, 2])).toBeNull();
    expect(toCoords(undefined)).toBeNull();
    expect(toCoords({ x: '1', y: 2 })).toBeNull();
  });

  it('carries real coords through onto the normalised throw', () => {
    const t = normalizeThrow({ segment: { name: 'T20', bed: 'Triple' }, coords: { x: 0.6, y: -0.1 } });
    expect(t.coords).toEqual({ x: 102, y: -17 });
  });
});

describe('normalised throws', () => {
  it('derives the score from the segment rather than trusting the board', () => {
    const t = normalizeThrow({ segment: { name: 'T20', bed: 'Triple' } });
    expect(t.value).toBe(60);
    expect(t.source).toBe('board');
  });

  it('gives every dart a distinct id', () => {
    const a = normalizeThrow({ segment: { name: 'T20', bed: 'Triple' } });
    const b = normalizeThrow({ segment: { name: 'T20', bed: 'Triple' } });
    expect(a.id).not.toBe(b.id);
  });
});

/*
 * The whole coordinate path, end to end: the fake board emits what the real
 * board emits, the adapter reads it, and the dart has to come back out inside
 * the wedge it was thrown into.
 *
 * This is the test that would have caught the mirrored y. The ones above check
 * a radius or a single number; only an angle can tell the two conventions
 * apart, because a radius is the same under either sign.
 */
describe('the coordinate round trip', () => {
  /** Degrees clockwise from 12 o'clock, which is how segments are laid out. */
  function bearing(c: { x: number; y: number }): number {
    return (((Math.atan2(c.x, c.y) * 180) / Math.PI) + 360) % 360;
  }

  it('lands every segment back inside its own wedge', () => {
    for (const ring of ['SINGLE_INNER', 'SINGLE_OUTER', 'TRIPLE', 'DOUBLE'] as const) {
      for (const [index, number] of SEGMENT_ORDER.entries()) {
        const segment: Segment = { number, ring };
        const coords = toCoords(toRawCoords(segment));
        expect(coords, `${ring} ${number} lost its coordinates`).not.toBeNull();

        const want = index * SEGMENT_ANGLE;
        // Signed difference, so 359 vs 1 degree reads as 2 rather than 358.
        const off = Math.abs(((bearing(coords!) - want + 540) % 360) - 180);
        expect(off, `${ring} ${number} plotted ${off.toFixed(1)}° from its wedge`)
          .toBeLessThan(SEGMENT_ANGLE / 2);
      }
    }
  });

  it('keeps 20 at the top and 3 at the bottom, the way they are read', () => {
    expect(toCoords(toRawCoords({ number: 20, ring: 'TRIPLE' }))!.y).toBeGreaterThan(0);
    expect(toCoords(toRawCoords({ number: 3, ring: 'TRIPLE' }))!.y).toBeLessThan(0);
  });
});
