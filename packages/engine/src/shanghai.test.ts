import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'shanghai',
    startRound: 1,
    endRound: 3,
    instantWin: true,
    legsToWin: 1,
    setsToWin: 1,
    ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

beforeEach(resetDartIds);

describe('Shanghai scoring', () => {
  it('only scores darts on the round number', () => {
    const m = newMatch();
    play(m, 'S1', 'T20', 'D1'); // round 1: S1=1, T20 off-target=0, D1=2
    expect(scoreOf(m, ALICE)).toBe(3);
  });

  it('shares one round across every player before advancing', () => {
    const m = newMatch();
    play(m, 'MISS', 'MISS', 'MISS'); // Alice's round-1 turn
    play(m, 'MISS', 'MISS', 'MISS'); // Bob's round-1 turn
    expect(m.view.players[0]?.detail.round).toBe(2);
  });
});

describe('Shanghai instant win', () => {
  it('wins immediately on a single, double and triple of the round number', () => {
    const m = newMatch();
    play(m, 'S1', 'D1', 'T1');
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('does not win instantly when instantWin is off', () => {
    const m = newMatch({ instantWin: false });
    play(m, 'S1', 'D1', 'T1');
    expect(m.view.winnerId).toBeNull();
  });

  it('records the winning round in the results card', () => {
    const m = newMatch();
    play(m, 'S1', 'D1', 'T1');
    expect(m.view.players[0]?.detail.results).toEqual([6]);
  });
});

describe('Shanghai finishing', () => {
  it('awards the round to the highest score once every round is played', () => {
    const m = newMatch({ startRound: 1, endRound: 1, instantWin: false });
    play(m, 'S1', 'MISS', 'MISS'); // Alice 1
    play(m, 'D1', 'MISS', 'MISS'); // Bob 2
    expect(m.view.winnerId).toBe(BOB);
  });

  it('emits a throw.recorded event with the scored value', () => {
    const m = newMatch();
    const events = m.apply(throwCmd('D1'));
    expect(events).toContainEqual({ type: 'throw.recorded', playerId: ALICE, dartIndex: 0, value: 2 });
  });
});
