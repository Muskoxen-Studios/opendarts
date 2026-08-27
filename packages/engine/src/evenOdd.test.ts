import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'evenodd',
    startingScore: 0,
    targetScore: 100,
    legsToWin: 1,
    setsToWin: 1,
    roundLimit: null,
    ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

beforeEach(resetDartIds);

describe('Even/Odd scoring', () => {
  it('adds the scored value for a single on an even number', () => {
    const m = newMatch();
    play(m, 'S4', 'MISS', 'MISS');
    expect(scoreOf(m, ALICE)).toBe(4);
  });

  it('subtracts the scored value for a single on an odd number', () => {
    const m = newMatch();
    play(m, 'S5', 'MISS', 'MISS');
    expect(scoreOf(m, ALICE)).toBe(-5);
  });

  it('applies the ring multiplier before adding, for an even double', () => {
    const m = newMatch();
    play(m, 'D6', 'MISS', 'MISS'); // even wedge, double ring: +12
    expect(scoreOf(m, ALICE)).toBe(12);
  });

  it('applies the ring multiplier before subtracting, for an odd triple', () => {
    const m = newMatch();
    play(m, 'T7', 'MISS', 'MISS'); // odd wedge, triple ring: -21
    expect(scoreOf(m, ALICE)).toBe(-21);
  });

  it('adds 50 for the inner bull', () => {
    const m = newMatch();
    play(m, 'BULL', 'MISS', 'MISS');
    expect(scoreOf(m, ALICE)).toBe(50);
  });

  it('subtracts 25 for the outer bull', () => {
    const m = newMatch();
    play(m, '25', 'MISS', 'MISS');
    expect(scoreOf(m, ALICE)).toBe(-25);
  });

  it('leaves the score unchanged on a miss', () => {
    const m = newMatch();
    play(m, 'MISS', 'MISS', 'MISS');
    expect(scoreOf(m, ALICE)).toBe(0);
  });

  it('lets a score go negative with no floor', () => {
    const m = newMatch();
    play(m, 'S5', 'S7', 'S9'); // -5 -7 -9
    expect(scoreOf(m, ALICE)).toBe(-21);
  });

  it('emits a throw.recorded event with the signed scored value', () => {
    const m = newMatch();
    const events = m.apply(throwCmd('S5'));
    expect(events).toContainEqual({ type: 'throw.recorded', playerId: ALICE, dartIndex: 0, value: -5 });
  });
});

describe('Even/Odd turn end', () => {
  it('ends a turn after three darts without reaching the target', () => {
    const m = newMatch({ targetScore: 1000 });
    play(m, 'S4', 'S4', 'S4');
    expect(m.view.activePlayerId).toBe(BOB);
  });

  it('holds the turn for takeout before advancing', () => {
    const m = newMatch({ targetScore: 1000 });
    m.apply(throwCmd('S4'));
    m.apply(throwCmd('S4'));
    m.apply(throwCmd('S4'));
    expect(m.view.awaitingTakeout).toBe(true);
    expect(m.view.activePlayerId).toBe(ALICE);
    m.apply({ type: 'ADVANCE_TURN' });
    expect(m.view.activePlayerId).toBe(BOB);
  });
});

describe('Even/Odd finishing', () => {
  it('wins the leg the instant a player reaches the target score', () => {
    const m = newMatch({ targetScore: 20 });
    play(m, 'D10', 'MISS', 'MISS'); // +20, reached mid-turn
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('wins the leg when a player crosses the target score', () => {
    const m = newMatch({ targetScore: 15 });
    play(m, 'D10', 'MISS', 'MISS'); // +20, crosses 15
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('rolls legs into a set and finishes the match once legsToWin is met', () => {
    const m = newMatch({ targetScore: 20, legsToWin: 2 });
    play(m, 'D10', 'MISS', 'MISS'); // Alice wins leg 1
    expect(m.view.status).toBe('playing');
    expect(m.view.players.find((p) => p.playerId === ALICE)?.legsWon).toBe(1);

    // Bob starts leg 2 (rotation), then Alice wins it too.
    play(m, 'MISS', 'MISS', 'MISS');
    play(m, 'D10', 'MISS', 'MISS');
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('resets scores to startingScore on RESTART_LEG', () => {
    const m = newMatch({ startingScore: 10 });
    play(m, 'S4', 'MISS', 'MISS');
    expect(scoreOf(m, ALICE)).toBe(14);
    m.apply({ type: 'RESTART_LEG' });
    expect(scoreOf(m, ALICE)).toBe(10);
    expect(scoreOf(m, BOB)).toBe(10);
  });
});

describe('Even/Odd players', () => {
  it('seeds a newly added player at startingScore', () => {
    const m = newMatch({ startingScore: 5 });
    m.apply({ type: 'ADD_PLAYER', player: { id: 'cara', name: 'Cara', color: '#fff' } });
    expect(scoreOf(m, 'cara')).toBe(5);
  });

  it('removes a player and their score', () => {
    const m = newMatch();
    m.apply({ type: 'REMOVE_PLAYER', playerId: BOB });
    expect(m.view.players.find((p) => p.playerId === BOB)).toBeUndefined();
  });
});

describe('Even/Odd END_MATCH', () => {
  it('picks the player with the higher score as leader', () => {
    const m = newMatch({ targetScore: 1000 });
    play(m, 'S4', 'MISS', 'MISS'); // Alice: +4
    play(m, 'S5', 'MISS', 'MISS'); // Bob: -5
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe(ALICE);
  });
});
