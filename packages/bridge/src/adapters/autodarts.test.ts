import { describe, it, expect } from 'vitest';
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
  it('is null regardless of what the board sends, until the payload is understood', () => {
    expect(toCoords({ x: 1, y: 2 })).toBeNull();
    expect(toCoords([1, 2])).toBeNull();
    expect(toCoords(undefined)).toBeNull();
  });

  it('produces throws with null coords', () => {
    const t = normalizeThrow({ segment: { name: 'T20', bed: 'Triple' }, coords: { x: 5, y: 5 } });
    expect(t.coords).toBeNull();
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
