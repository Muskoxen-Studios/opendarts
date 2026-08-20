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

  it('requires a player to hit their own double before they can kill', () => {
    const m = readyMatch();
    expect(detail(m, ALICE).isKiller).toBe(false);
    play(m, 'D5');
    expect(detail(m, ALICE).isKiller).toBe(true);
  });

  it("a killer hitting an opponent's double costs them a life", () => {
    const m = readyMatch();
    play(m, 'D5', 'D6', 'MISS'); // Alice becomes killer, then hits Bob's double
    expect(detail(m, BOB).lives).toBe(2);
  });

  it('eliminates a player at zero lives and skips them in turn order', () => {
    const m = readyMatch();
    play(m, 'D5', 'D6', 'MISS'); // Alice: killer, Bob -> 2 lives
    play(m, 'MISS', 'MISS', 'MISS'); // Bob's turn, nothing happens
    play(m, 'D6', 'D6'); // Alice: Bob 2 -> 1 -> 0, eliminated, match ends
    expect(detail(m, BOB).eliminated).toBe(true);
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('emits a killer.becameKiller event', () => {
    const m = readyMatch();
    const events = m.apply(throwCmd('D5'));
    expect(events).toContainEqual({ type: 'killer.becameKiller', playerId: ALICE });
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
    play(m, 'D5', 'D6', 'MISS'); // Alice becomes killer, Bob loses a life
    expect(detail(m, BOB).lives).toBe(2);
    m.apply({ type: 'RESTART_LEG' });
    expect(detail(m, ALICE).lives).toBe(5);
    expect(detail(m, BOB).lives).toBe(3);
  });
});
