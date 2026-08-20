import { describe, it, expect } from 'vitest';
import type { GameType } from '@darts/schema';
import type { MatchAnalysis, ThrowRecord } from './analysis.ts';
import {
  HANDICAP_REFERENCE_AVG,
  computeGotchaHandicap,
  computeKillerHandicap,
  computeX01Handicap,
  skillAverage,
} from './handicap.ts';

const ALICE = 'alice';

function throwOf(value: number): ThrowRecord {
  return {
    playerId: ALICE,
    label: `S${value}`,
    value,
    counted: value,
    ring: 'SINGLE_OUTER',
    number: value,
    scoreBefore: 0,
    hadCheckout: false,
    leg: 1,
    coords: null,
  };
}

/** A finished match where Alice threw exactly these dart values, in order. */
function match(gameType: GameType, values: number[], matchId = 'm1'): MatchAnalysis {
  return {
    matchId,
    gameType,
    players: [{ id: ALICE, name: 'Alice', color: '#000' }],
    winnerId: null,
    endedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    throws: values.map(throwOf),
    turns: [],
    checkouts: [],
    knockbacks: [],
    legsWon: { alice: 0 },
    legsPlayed: 0,
    cricketMarks: { alice: 0 },
    cutthroatTurnPoints: { alice: [] },
    golf: null,
    shanghai: null,
    conceded: false,
  };
}

describe('skillAverage', () => {
  it('has no average without any history', () => {
    expect(skillAverage(ALICE, [], 'x01').avg).toBeNull();
  });

  it('turns a mean dart value into a 3-dart-average-style number', () => {
    const a = match('x01', [10, 10, 10]);
    const result = skillAverage(ALICE, [a], 'x01');
    expect(result.avg).toBe(30);
    expect(result.matches).toBe(1);
    expect(result.counted).toBe(1);
  });

  it('only counts matches of the requested game type', () => {
    const a = match('x01', [10, 10, 10]);
    expect(skillAverage(ALICE, [a], 'gotcha').avg).toBeNull();
  });

  it('ignores matches the player did not appear in', () => {
    const a = match('x01', [10, 10, 10]);
    expect(skillAverage('bob', [a], 'x01').avg).toBeNull();
  });

  it('averages the best matches of a full window, same ramp-up as Golf', () => {
    const analyses: MatchAnalysis[] = [];
    for (let i = 0; i < 15; i++) analyses.push(match('x01', [5, 5, 5], `weak${i}`));
    for (let i = 0; i < 5; i++) analyses.push(match('x01', [20, 20, 20], `strong${i}`));

    const result = skillAverage(ALICE, analyses, 'x01');
    expect(result.matches).toBe(20);
    expect(result.counted).toBe(8);
    // The best 8 of 20 are the 5 strong matches (60 each) plus 3 of the weak
    // (15 each): (5*60 + 3*15) / 8 = 43.125.
    expect(result.avg).toBeCloseTo(43.125);
  });
});

describe('computeX01Handicap', () => {
  it('suggests the base start score with no history', () => {
    const result = computeX01Handicap(ALICE, [], 501);
    expect(result.handicap).toBe(501);
    expect(result.counted).toBe(0);
  });

  it('gives a scratch-or-better player no adjustment', () => {
    const a = match('x01', [HANDICAP_REFERENCE_AVG / 3, HANDICAP_REFERENCE_AVG / 3, HANDICAP_REFERENCE_AVG / 3]);
    expect(computeX01Handicap(ALICE, [a], 500).handicap).toBe(500);
  });

  it('scales a weaker player down, rounded to the nearest 25', () => {
    // Average of 20 (a 3-dart average of 20) is exactly half of the reference.
    const a = match('x01', [20 / 3, 20 / 3, 20 / 3]);
    const result = computeX01Handicap(ALICE, [a], 500);
    expect(result.handicap).toBe(250);
  });

  it('never scales below 40% of the base start score', () => {
    const a = match('x01', [1, 1, 1]);
    const result = computeX01Handicap(ALICE, [a], 500);
    expect(result.handicap).toBe(200);
  });
});

describe('computeGotchaHandicap', () => {
  it('suggests no head start with no history', () => {
    expect(computeGotchaHandicap(ALICE, [], 301).handicap).toBe(0);
  });

  it('gives a scratch-or-better player no head start', () => {
    const a = match('gotcha', [HANDICAP_REFERENCE_AVG / 3, HANDICAP_REFERENCE_AVG / 3, HANDICAP_REFERENCE_AVG / 3]);
    expect(computeGotchaHandicap(ALICE, [a], 301).handicap).toBe(0);
  });

  it('gives a weaker player a head start proportional to the shortfall', () => {
    // Half the reference average earns half the target as a head start.
    const a = match('gotcha', [20 / 3, 20 / 3, 20 / 3]);
    expect(computeGotchaHandicap(ALICE, [a], 300).handicap).toBe(150);
  });

  it('never reaches the target itself', () => {
    const a = match('gotcha', [0, 0, 0]);
    expect(computeGotchaHandicap(ALICE, [a], 300).handicap).toBe(299);
  });
});

describe('computeKillerHandicap', () => {
  it('suggests the base lives with no history', () => {
    expect(computeKillerHandicap(ALICE, [], 3).handicap).toBe(3);
  });

  it('gives a scratch-or-better player no extra lives', () => {
    const a = match('killer', [HANDICAP_REFERENCE_AVG / 3, HANDICAP_REFERENCE_AVG / 3, HANDICAP_REFERENCE_AVG / 3]);
    expect(computeKillerHandicap(ALICE, [a], 3).handicap).toBe(3);
  });

  it('gives a weaker player extra lives, clamped to 9', () => {
    const a = match('killer', [1, 1, 1]);
    expect(computeKillerHandicap(ALICE, [a], 3).handicap).toBe(9);
  });
});
