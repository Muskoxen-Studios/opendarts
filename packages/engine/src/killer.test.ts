import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, throwCmd } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'killer',
    startingLives: 3,
    friendlyFire: false,
    legsToWin: 1,
    setsToWin: 1,
    ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

function detail(m: Match, playerId: string): Record<string, unknown> {
  return m.view.players.find((p) => p.playerId === playerId)!.detail;
}

beforeEach(resetDartIds);

describe('Killer number assignment', () => {
  it('claims the first eligible hit and ends the turn', () => {
    const m = newMatch();
    play(m, 'S5');
    expect(detail(m, ALICE).number).toBe(5);
    expect(m.view.activePlayerId).toBe(BOB);
  });

  it('does not let a second player claim an already-claimed number', () => {
    const m = newMatch();
    play(m, 'S5');
    play(m, 'S5', 'S6'); // Bob's first dart re-hits Alice's number, ignored; second dart claims 6
    expect(detail(m, BOB).number).toBe(6);
  });

  it('moves to the play phase once everyone has a number', () => {
    const m = newMatch();
    play(m, 'S5');
    play(m, 'S6');
    expect(detail(m, ALICE).phase).toBe('play');
    expect(detail(m, BOB).phase).toBe('play');
  });
});

describe('Killer play', () => {
  function readyMatch(): Match {
    const m = newMatch();
    play(m, 'S5'); // Alice claims 5
    play(m, 'S6'); // Bob claims 6, phase -> play, active -> Alice
    return m;
  }

  it('takes three hits on your own number to become a killer', () => {
    const m = readyMatch();
    play(m, 'S5', 'S5');
    expect(detail(m, ALICE).isKiller).toBe(false);
    expect(detail(m, ALICE).ownHits).toBe(2);
    play(m, 'S5');
    expect(detail(m, ALICE).isKiller).toBe(true);
  });

  it('counts a triple of your own number as all three hits at once', () => {
    const m = readyMatch();
    play(m, 'T5');
    expect(detail(m, ALICE).isKiller).toBe(true);
  });

  it('carries killer progress across turns', () => {
    const m = readyMatch();
    play(m, 'D5', 'MISS', 'MISS'); // Alice: 2 hits
    play(m, 'MISS', 'MISS', 'MISS'); // Bob
    expect(detail(m, ALICE).ownHits).toBe(2);
    play(m, 'S5');
    expect(detail(m, ALICE).isKiller).toBe(true);
  });

  it("a killer's single on an opponent's number costs them a third of a life", () => {
    const m = readyMatch();
    play(m, 'T5', 'S6', 'MISS'); // Alice becomes killer, then a single on Bob's 6
    expect(detail(m, BOB).lives).toBeCloseTo(2 + 2 / 3);
  });

  it("a killer's triple on an opponent's number costs them a whole life", () => {
    const m = readyMatch();
    play(m, 'T5', 'T6', 'MISS');
    expect(detail(m, BOB).lives).toBe(2);
  });

  it('does nothing when a player who is not yet a killer hits an opponent', () => {
    const m = readyMatch();
    play(m, 'T6', 'MISS', 'MISS');
    expect(detail(m, BOB).lives).toBe(3);
  });

  it('eliminates a player at zero lives and ends the match', () => {
    const m = readyMatch();
    play(m, 'T5', 'T6', 'T6'); // Alice: killer, Bob 3 -> 2 -> 1
    play(m, 'MISS', 'MISS', 'MISS'); // Bob's turn, nothing happens
    play(m, 'T6'); // Bob -> 0, eliminated, match ends
    expect(detail(m, BOB).eliminated).toBe(true);
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('leaves your own number harmless with friendly fire off', () => {
    const m = readyMatch();
    play(m, 'T5', 'S5', 'MISS');
    expect(detail(m, ALICE).lives).toBe(3);
  });

  it('costs a killer a third of a life per hit on their own number with friendly fire on', () => {
    const m = newMatch({ friendlyFire: true });
    play(m, 'S5');
    play(m, 'S6');
    play(m, 'T5', 'S5', 'MISS');
    expect(detail(m, ALICE).lives).toBeCloseTo(3 - 1 / 3);
  });

  it('spends the leftover hits of the crowning dart on friendly fire', () => {
    const m = newMatch({ friendlyFire: true });
    play(m, 'S5');
    play(m, 'S6');
    play(m, 'D5', 'D5', 'MISS'); // 4 hits: 3 crown Alice, the 4th hits her
    expect(detail(m, ALICE).isKiller).toBe(true);
    expect(detail(m, ALICE).lives).toBeCloseTo(3 - 1 / 3);
  });

  it('emits a killer.becameKiller event', () => {
    const m = readyMatch();
    const events = m.apply(throwCmd('T5'));
    expect(events).toContainEqual({ type: 'killer.becameKiller', playerId: ALICE });
  });

  it('reports the damage and the remaining thirds on a hit', () => {
    const m = readyMatch();
    m.apply(throwCmd('T5'));
    const events = m.apply(throwCmd('D6'));
    expect(events).toContainEqual({
      type: 'killer.hit',
      byPlayerId: ALICE,
      victimPlayerId: BOB,
      hits: 2,
      livesLeftThirds: 7,
    });
  });
});

describe('Killer handicaps', () => {
  it('seats a player with their handicap lives instead of the default', () => {
    const m = newMatch({ startingLives: 3, handicaps: { alice: 5 } });
    expect(detail(m, ALICE).lives).toBe(5);
    expect(detail(m, BOB).lives).toBe(3);
  });

  it('restores the handicap lives on a leg restart', () => {
    const m = newMatch({ startingLives: 3, handicaps: { alice: 5 } });
    play(m, 'S5');
    play(m, 'S6');
    play(m, 'T5', 'T6', 'MISS'); // Alice becomes killer, Bob loses a life
    expect(detail(m, BOB).lives).toBe(2);
    m.apply({ type: 'RESTART_LEG' });
    expect(detail(m, ALICE).lives).toBe(5);
    expect(detail(m, BOB).lives).toBe(3);
  });
});
