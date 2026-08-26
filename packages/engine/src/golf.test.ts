import { describe, it, expect, beforeEach } from 'vitest';
import type { GolfConfig } from '@darts/schema';
import { Match } from './match.ts';
import {
  handicapOf,
  personalPar,
  stablefordPoints,
  roundStrokes,
  strokeAllowance,
  type GolfHoleResult,
} from './golf.ts';
import { play, players, resetDartIds } from './testkit.ts';

const ROSTER = players('Alice', 'Bob');
const [ALICE, BOB] = ['alice', 'bob'];

function config(over: Partial<GolfConfig> = {}): GolfConfig {
  return {
    gameType: 'golf',
    holes: 18,
    par: 4,
    handicaps: {},
    legsToWin: 1,
    setsToWin: 1,
    roundLimit: null,
    ...over,
  };
}

function start(cfg: GolfConfig, roster = ROSTER): Match {
  const m = new Match('g1', roster, cfg);
  m.apply({ type: 'START' });
  return m;
}

function detail(m: Match, playerId: string): Record<string, unknown> {
  const p = m.view.players.find((x) => x.playerId === playerId);
  if (!p) throw new Error(`no such player: ${playerId}`);
  return p.detail;
}

function card(m: Match, playerId: string): GolfHoleResult[] {
  return detail(m, playerId).results as GolfHoleResult[];
}

function pointsOf(m: Match, playerId: string): number {
  return m.view.players.find((p) => p.playerId === playerId)?.score ?? 0;
}

beforeEach(resetDartIds);

describe('handicap strokes', () => {
  it('spreads the handicap evenly and deals the remainder from hole 1', () => {
    // The worked example: handicap 20 over 18 holes is one stroke everywhere
    // plus an extra on the first two holes.
    expect(strokeAllowance(20, 18, 1)).toBe(2);
    expect(strokeAllowance(20, 18, 2)).toBe(2);
    expect(strokeAllowance(20, 18, 3)).toBe(1);
    expect(strokeAllowance(20, 18, 18)).toBe(1);
  });

  it('gives a shorter round its share of the handicap, not the whole of it', () => {
    // The handicap is a full-round figure. Nine holes off 36 is 18 strokes,
    // which is the same two a hole -- and the same net par 6 -- an eighteen
    // hole round gets. Spreading all 36 over nine would give four a hole.
    expect(roundStrokes(36, 9)).toBe(18);
    expect(strokeAllowance(36, 9, 1)).toBe(2);
    expect(strokeAllowance(36, 9, 9)).toBe(2);
    expect(personalPar({ ...config(), holes: 9 }, ALICE, 1)).toBe(6);

    // An odd share is dealt from hole 1 up, same as a full round's remainder.
    expect(roundStrokes(27, 6)).toBe(9);
    expect(strokeAllowance(27, 6, 1)).toBe(2);
    expect(strokeAllowance(27, 6, 4)).toBe(1);
  });

  it('gives a newcomer two strokes a hole, so personal par is 6', () => {
    const cfg = config();
    expect(handicapOf(cfg, ALICE)).toBe(36);
    expect(personalPar(cfg, ALICE, 1)).toBe(6);
    expect(personalPar(cfg, ALICE, 18)).toBe(6);
  });

  it('gives a scratch player bare par', () => {
    const cfg = config({ handicaps: { alice: 0 } });
    expect(personalPar(cfg, ALICE, 1)).toBe(4);
  });
});

describe('stableford points', () => {
  it('scores from albatross down to one over par', () => {
    expect(stablefordPoints(4, 1, true)).toBe(5);
    expect(stablefordPoints(4, 2, true)).toBe(4);
    expect(stablefordPoints(4, 3, true)).toBe(3);
    expect(stablefordPoints(4, 4, true)).toBe(2);
    expect(stablefordPoints(4, 5, true)).toBe(1);
  });

  it('scores nothing for a hole that was never holed out', () => {
    expect(stablefordPoints(4, 5, false)).toBe(0);
  });

  it('caps a very early hit at an albatross', () => {
    // Personal par 6 holed with the first dart is five under, not seven points.
    expect(stablefordPoints(6, 1, true)).toBe(5);
  });
});

describe('playing a hole', () => {
  it('holes out on any ring of the hole number', () => {
    const m = start(config({ holes: 2, handicaps: { alice: 0, bob: 0 } }));
    play(m, 'T1');
    expect(card(m, ALICE)[0]).toMatchObject({ hole: 1, strokes: 1, points: 5, holed: true });
    expect(pointsOf(m, ALICE)).toBe(5);
  });

  it('counts every dart as a stroke, including misses', () => {
    const m = start(config({ holes: 2, handicaps: { alice: 0, bob: 0 } }));
    play(m, 'S20', 'S20', 'S1');
    expect(card(m, ALICE)[0]).toMatchObject({ strokes: 3, points: 3, holed: true });
  });

  it('abandons the hole one stroke over par, scoring nothing', () => {
    const m = start(config({ holes: 2, handicaps: { alice: 0 } }), players('Alice'));
    // Par 4, so the fifth fruitless dart ends it.
    play(m, 'S20', 'S20', 'S20', 'S20', 'S20');
    expect(card(m, ALICE)[0]).toMatchObject({ strokes: 5, points: 0, holed: false });
    // And the player has moved on to hole 2 with a clean slate.
    expect(detail(m, ALICE).hole).toBe(2);
    expect(detail(m, ALICE).strokes).toBe(0);
  });

  it('still scores a point for holing out exactly one over par', () => {
    const m = start(config({ holes: 2, handicaps: { alice: 0 } }), players('Alice'));
    play(m, 'S20', 'S20', 'S20', 'S20', 'S1');
    expect(card(m, ALICE)[0]).toMatchObject({ strokes: 5, points: 1, holed: true });
  });

  it('carries an unfinished hole across the turn boundary', () => {
    const m = start(config({ holes: 3, handicaps: { alice: 0, bob: 0 } }));
    play(m, 'S20', 'S20', 'S20');
    // Alice has spent three strokes and handed over, still on hole 1.
    expect(detail(m, ALICE).hole).toBe(1);
    expect(detail(m, ALICE).strokes).toBe(3);
    expect(m.view.activePlayerId).toBe(BOB);

    play(m, 'S20', 'S20', 'S20');
    expect(m.view.activePlayerId).toBe(ALICE);
    play(m, 'S1');
    expect(card(m, ALICE)[0]).toMatchObject({ strokes: 4, points: 2, holed: true });
  });

  it('spends the rest of the turn on the next hole', () => {
    const m = start(config({ holes: 3, handicaps: { alice: 0, bob: 0 } }));
    play(m, 'S1', 'S2');
    expect(card(m, ALICE)).toHaveLength(2);
    expect(card(m, ALICE)[1]).toMatchObject({ hole: 2, strokes: 1, points: 5 });
    expect(detail(m, ALICE).hole).toBe(3);
  });
});

describe('a full round', () => {
  it('is won by the most points and ends when everyone has played out', () => {
    const cfg = config({ holes: 2, handicaps: { alice: 0, bob: 0 } });
    const m = start(cfg);

    play(m, 'S1', 'S2'); // Alice: two albatrosses, 10 points, round complete
    expect(detail(m, ALICE).done).toBe(true);
    expect(m.view.activePlayerId).toBe(BOB);
    expect(m.view.status).toBe('playing');

    // Bob needs two darts a hole: 4 points each.
    play(m, 'S20', 'S1', 'S20');
    play(m, 'S2');

    expect(pointsOf(m, ALICE)).toBe(10);
    expect(pointsOf(m, BOB)).toBe(8);
    expect(m.view.status).toBe('finished');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('does not give a finished player another turn', () => {
    const m = start(config({ holes: 1, handicaps: { alice: 0, bob: 0 } }));
    play(m, 'S1');
    expect(m.view.activePlayerId).toBe(BOB);
    play(m, 'S20', 'S20');
    // Bob is still going; the rotation has nobody else to visit.
    expect(m.view.activePlayerId).toBe(BOB);
  });

  it('scores exactly 36 for a newcomer who plays every hole to personal par', () => {
    // Personal par 6 off the starting handicap of 36: two points a hole, 18
    // holes, 36 points -- which is what makes 36 the handicap it predicts.
    const m = start(config(), players('Alice'));
    for (let hole = 1; hole <= 18; hole++) {
      for (let dart = 1; dart < 6; dart++) play(m, 'MISS');
      play(m, `S${hole}`);
    }
    expect(pointsOf(m, 'alice')).toBe(36);
    expect(m.view.status).toBe('finished');
  });
});

describe('the view', () => {
  it('offers the hole number as the aim for every dart left in the turn', () => {
    const m = start(config({ holes: 3, handicaps: { alice: 0, bob: 0 } }));
    expect(m.view.turn.hints).toEqual(['1', '1', '1']);
    play(m, 'S20');
    expect(m.view.turn.hints).toEqual(['1', '1']);
  });

  it('reports the turn total in points, not in board value', () => {
    const m = start(config({ holes: 3, handicaps: { alice: 0, bob: 0 } }));
    play(m, 'T20');
    expect(m.view.turn.total).toBe(0);
    play(m, 'S1');
    expect(m.view.turn.total).toBe(4);
  });
});
