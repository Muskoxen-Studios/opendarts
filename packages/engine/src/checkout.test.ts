import { describe, it, expect } from 'vitest';
import { isBogeyNumber, suggestCheckout } from './checkout.ts';

describe('checkout routes', () => {
  it('finds the maximum finish', () => {
    expect(suggestCheckout(170, 3)).toEqual(['T20', 'T20', 'BULL']);
  });

  it('finds common finishes', () => {
    expect(suggestCheckout(141, 3)).toEqual(['T20', 'T19', 'D12']);
    expect(suggestCheckout(100, 2)).toEqual(['T20', 'D20']);
    expect(suggestCheckout(40, 1)).toEqual(['D20']);
  });

  it('rejects the bogey numbers', () => {
    for (const score of [169, 168, 166, 165, 163, 162, 159]) {
      expect(suggestCheckout(score, 3)).toBeNull();
      expect(isBogeyNumber(score)).toBe(true);
    }
  });

  it('cannot finish 1 under double-out', () => {
    expect(suggestCheckout(1, 3)).toBeNull();
  });

  it('finishes on the easiest legal dart under straight-out', () => {
    // S20 and D10 both score 20; the single is far the better advice.
    expect(suggestCheckout(20, 1, 'straight')).toEqual(['S20']);
    expect(suggestCheckout(3, 3, 'straight')).toEqual(['S3']);
  });

  it('requires a double or triple under master-out', () => {
    expect(suggestCheckout(60, 1, 'master')).toEqual(['T20']);
    // 20 is still fine under master-out -- D10 is a double.
    expect(suggestCheckout(20, 1, 'master')).toEqual(['D10']);
    // 23 is neither a double nor a triple of anything on the board.
    expect(suggestCheckout(23, 1, 'master')).toBeNull();
    // ...but a single 23 does not exist either, so straight-out cannot do it in one.
    expect(suggestCheckout(23, 1, 'straight')).toBeNull();
  });
});

describe('when advice is offered at all', () => {
  // Hints are only useful once a finish is actually on. Below, `null` means the
  // scoreboard shows empty slots rather than speculative advice.
  it('offers nothing from a score that cannot be finished this turn', () => {
    expect(suggestCheckout(501, 3)).toBeNull();
    expect(suggestCheckout(180, 3)).toBeNull();
    expect(suggestCheckout(171, 3)).toBeNull();
  });

  it('offers nothing once too few darts remain', () => {
    expect(suggestCheckout(100, 3)).not.toBeNull();
    expect(suggestCheckout(100, 1)).toBeNull();
  });

  it('starts offering advice exactly at the highest checkable score', () => {
    expect(suggestCheckout(170, 3)).not.toBeNull();
  });

  it('offers a route shorter than the darts remaining', () => {
    // On 40 with three darts left, only the first slot carries advice.
    expect(suggestCheckout(40, 3)).toEqual(['D20']);
  });

  it('accounts for the out-rule when deciding there is a finish', () => {
    // 3 is checkable under straight-out, but not with one dart under double-out.
    expect(suggestCheckout(3, 1, 'straight')).toEqual(['S3']);
    expect(suggestCheckout(3, 1, 'double')).toBeNull();
  });
});
