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
  it('scales by 170 and flips y, board-down to schema-up', () => {
    expect(toCoords({ x: 0.5, y: 0.25 })).toEqual({ x: 85, y: -42.5 });
  });

  it('is null for anything that does not parse as {x, y}', () => {
    expect(toCoords([1, 2])).toBeNull();
    expect(toCoords(undefined)).toBeNull();
    expect(toCoords({ x: '1', y: 2 })).toBeNull();
  });

  it('carries real coords through onto the normalised throw', () => {
    const t = normalizeThrow({ segment: { name: 'T20', bed: 'Triple' }, coords: { x: 0.6, y: -0.1 } });
    expect(t.coords).toEqual({ x: 102, y: 17 });
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
