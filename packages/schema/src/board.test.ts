import { describe, it, expect } from 'vitest';
import { segmentValue, segmentMarks, segmentLabel, isDouble, SEGMENT_ORDER } from './board.ts';

describe('segment scoring', () => {
  it('scores singles, doubles and triples', () => {
    expect(segmentValue({ number: 20, ring: 'SINGLE_OUTER' })).toBe(20);
    expect(segmentValue({ number: 20, ring: 'TRIPLE' })).toBe(60);
    expect(segmentValue({ number: 16, ring: 'DOUBLE' })).toBe(32);
  });

  it('scores bulls', () => {
    expect(segmentValue({ number: 25, ring: 'BULL' })).toBe(50);
    expect(segmentValue({ number: 25, ring: 'OUTER_BULL' })).toBe(25);
  });

  it('scores a miss as zero', () => {
    expect(segmentValue({ number: 0, ring: 'MISS' })).toBe(0);
  });

  it('counts cricket marks', () => {
    expect(segmentMarks({ number: 20, ring: 'TRIPLE' })).toBe(3);
    expect(segmentMarks({ number: 25, ring: 'BULL' })).toBe(2);
    expect(segmentMarks({ number: 25, ring: 'OUTER_BULL' })).toBe(1);
  });

  it('labels segments', () => {
    expect(segmentLabel({ number: 20, ring: 'TRIPLE' })).toBe('T20');
    expect(segmentLabel({ number: 25, ring: 'BULL' })).toBe('BULL');
  });

  it('treats the inner bull as a double for checkout purposes', () => {
    expect(isDouble({ number: 25, ring: 'BULL' })).toBe(true);
    expect(isDouble({ number: 25, ring: 'OUTER_BULL' })).toBe(false);
  });

  it('has 20 segments in the standard order', () => {
    expect(SEGMENT_ORDER).toHaveLength(20);
    expect(SEGMENT_ORDER[0]).toBe(20);
    expect(new Set(SEGMENT_ORDER).size).toBe(20);
  });
});
