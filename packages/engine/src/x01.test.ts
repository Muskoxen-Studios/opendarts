import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'x01',
    startScore: 501,
    inMode: 'straight',
    outMode: 'double',
    legsToWin: 1,
    setsToWin: 1,
    ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

beforeEach(resetDartIds);

describe('X01 basic scoring', () => {
  it('subtracts a 180 correctly', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    expect(scoreOf(m, ALICE)).toBe(321);
  });

  it('hands over after three darts', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    expect(m.view.activePlayerId).toBe(BOB);
    expect(m.view.turn.throws).toHaveLength(0);
  });

  it('tracks each player independently', () => {
    const m = newMatch();
    play(m, 'T20', 'T20', 'T20');
    play(m, '20', '20', '20');
    expect(scoreOf(m, ALICE)).toBe(321);
    expect(scoreOf(m, BOB)).toBe(441);
  });

  it('allows an early handover with fewer than three darts', () => {
    const m = newMatch();
    play(m, 'T20');
    m.apply({ type: 'NEXT_PLAYER' });
    expect(m.view.activePlayerId).toBe(BOB);
    expect(scoreOf(m, ALICE)).toBe(441);
  });
});

describe('X01 bust handling', () => {
  it('busts and restores the turn-start score when going below zero', () => {
    const m = newMatch({ startScore: 41 });
    play(m, '20');            // 21 left
    expect(scoreOf(m, ALICE)).toBe(21);
    play(m, 'T20');           // would be -39
    expect(scoreOf(m, ALICE)).toBe(41);
    expect(m.view.activePlayerId).toBe(BOB);
  });

  it('busts when leaving exactly 1 under double-out', () => {
    const m = newMatch({ startScore: 41 });
    play(m, '20');            // 21
    play(m, '20');            // would leave 1
    expect(scoreOf(m, ALICE)).toBe(41);
  });

  it('busts when finishing on a non-double under double-out', () => {
    const m = newMatch({ startScore: 40 });
    play(m, '20');            // 20 left
    play(m, '20');            // reaches 0 on a single
    expect(scoreOf(m, ALICE)).toBe(40);
  });

  it('permits leaving 1 under straight-out', () => {
    const m = newMatch({ startScore: 41, outMode: 'straight' });
    play(m, '20', '20');
    expect(scoreOf(m, ALICE)).toBe(1);
  });
});

describe('X01 finishing', () => {
  it('wins the leg on a double', () => {
    const m = newMatch({ startScore: 40 });
    play(m, 'D20');
    expect(m.view.status).toBe('finished');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('accepts the inner bull as a double', () => {
    const m = newMatch({ startScore: 50 });
    play(m, 'BULL');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('rejects the outer bull as a finishing double', () => {
    const m = newMatch({ startScore: 25 });
    play(m, '25');
    expect(scoreOf(m, ALICE)).toBe(25);
    expect(m.view.winnerId).toBeNull();
  });

  it('finishes on any segment under straight-out', () => {
    const m = newMatch({ startScore: 20, outMode: 'straight' });
    play(m, '20');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('requires a double or triple under master-out', () => {
    const m = newMatch({ startScore: 60, outMode: 'master' });
    play(m, 'T20');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('emits a checkout event carrying the dart count', () => {
    const m = newMatch({ startScore: 100 });
    play(m, 'T20');
    const events = m.apply(throwCmd('D20'));
    const checkout = events.find((e) => e.type === 'x01.checkout');
    expect(checkout).toMatchObject({ playerId: ALICE, darts: 2 });
  });
});

describe('X01 double-in', () => {
  it('ignores darts until a double is hit', () => {
    const m = newMatch({ inMode: 'double' });
    play(m, 'T20', '20');
    expect(scoreOf(m, ALICE)).toBe(501);
    play(m, 'D20');
    expect(scoreOf(m, ALICE)).toBe(461);
  });

  it('scores normally once in', () => {
    const m = newMatch({ inMode: 'double' });
    play(m, 'D20', 'T20', 'T20');
    expect(scoreOf(m, ALICE)).toBe(501 - 40 - 60 - 60);
  });

  it('reverts in-status when the same turn busts', () => {
    const m = newMatch({ inMode: 'double', startScore: 50 });
    play(m, 'D20');           // in, 10 left
    expect(scoreOf(m, ALICE)).toBe(10);
    play(m, 'T20');           // bust
    expect(scoreOf(m, ALICE)).toBe(50);
    // Back to needing a double to start again.
    const detail = m.view.players.find((p) => p.playerId === ALICE)?.detail;
    expect(detail?.startedIn).toBe(false);
  });
});

describe('X01 per-player handicaps', () => {
  it('gives each player their own starting score', () => {
    const m = newMatch({
      startScore: 501,
      perPlayer: { bob: { startScore: 301 } },
    });
    expect(scoreOf(m, ALICE)).toBe(501);
    expect(scoreOf(m, BOB)).toBe(301);
  });

  it('applies different out-rules to each player in the same leg', () => {
    const m = newMatch({
      startScore: 40,
      outMode: 'double',
      perPlayer: { bob: { outMode: 'straight' } },
    });
    // Alice cannot finish 40 on a single.
    play(m, '20', '20');
    expect(scoreOf(m, ALICE)).toBe(40);
    // Bob can.
    play(m, '20', '20');
    expect(m.view.winnerId).toBe(BOB);
  });

  it('combines a start-score and an in-rule handicap', () => {
    const m = newMatch({
      startScore: 501,
      inMode: 'straight',
      perPlayer: { alice: { startScore: 301, inMode: 'double' } },
    });
    play(m, 'T20');
    expect(scoreOf(m, ALICE)).toBe(301);
    play(m, 'D10');
    expect(scoreOf(m, ALICE)).toBe(281);
  });
});

describe('X01 legs and sets', () => {
  it('requires legsToWin legs to take the match', () => {
    const m = newMatch({ startScore: 40, legsToWin: 2 });
    play(m, 'D20');
    expect(m.view.winnerId).toBeNull();
    expect(m.view.players.find((p) => p.playerId === ALICE)?.legsWon).toBe(1);
    expect(m.view.leg).toBe(2);
    // Second leg starts with Bob.
    expect(m.view.activePlayerId).toBe(BOB);
    play(m, 'D20');
    expect(m.view.winnerId).toBeNull();
    play(m, 'D20');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('resets scores at the start of a new leg', () => {
    const m = newMatch({ startScore: 40, legsToWin: 2 });
    play(m, 'D20');
    expect(scoreOf(m, ALICE)).toBe(40);
    expect(scoreOf(m, BOB)).toBe(40);
  });
});

describe('X01 checkout hints in the turn slots', () => {
  it('fills the remaining slots when a finish is on', () => {
    const m = newMatch({ startScore: 170 });
    expect(m.view.turn.hints).toEqual(['T20', 'T20', 'BULL']);
  });

  it('shortens as darts are thrown', () => {
    const m = newMatch({ startScore: 170 });
    play(m, 'T20');
    expect(m.view.turn.hints).toEqual(['T20', 'BULL']);
    play(m, 'T20');
    expect(m.view.turn.hints).toEqual(['BULL']);
  });

  it('offers nothing when the score cannot be finished this turn', () => {
    expect(newMatch({ startScore: 501 }).view.turn.hints).toEqual([]);
    expect(newMatch({ startScore: 180 }).view.turn.hints).toEqual([]);
  });

  it('stays hidden while the score is out of range for the darts left', () => {
    // A two-dart finish tops out at 110 (T20 + bull), so coming down from 220
    // never becomes checkable within this turn -- the slots stay empty
    // throughout rather than flickering advice on and off.
    const m = newMatch({ startScore: 220 });
    expect(m.view.turn.hints).toEqual([]);
    play(m, 'T20');            // 160 left, two darts
    expect(m.view.turn.hints).toEqual([]);
    play(m, 'T20');            // 100 left, one dart
    expect(m.view.turn.hints).toEqual([]);
  });

  it('appears at the start of the next turn once the score is checkable', () => {
    const m = newMatch({ startScore: 220 });
    play(m, 'T20', 'T20', 'MISS');       // Alice leaves 100
    play(m, 'MISS', 'MISS', 'MISS');     // Bob
    expect(m.view.activePlayerId).toBe(ALICE);
    expect(m.view.turn.hints).toEqual(['T20', 'D20']);
  });

  it('offers a route on a bogey number only when it becomes checkable', () => {
    const m = newMatch({ startScore: 169 });
    expect(m.view.turn.hints).toEqual([]);
  });

  it('respects a per-player out-rule handicap', () => {
    const m = newMatch({ startScore: 20, outMode: 'double', perPlayer: { alice: { outMode: 'straight' } } });
    expect(m.view.turn.hints).toEqual(['S20']);
  });

  it('offers nothing once the match is over', () => {
    const m = newMatch({ startScore: 40 });
    play(m, 'D20');
    expect(m.view.turn.hints).toEqual([]);
  });
});

describe('X01 checkout suggestions', () => {
  it('suggests a route for the active player only', () => {
    const m = newMatch({ startScore: 170 });
    const alice = m.view.players.find((p) => p.playerId === ALICE);
    const bob = m.view.players.find((p) => p.playerId === BOB);
    expect(alice?.checkout).toEqual(['T20', 'T20', 'BULL']);
    expect(bob?.checkout).toBeNull();
  });

  it('offers no route on a bogey number', () => {
    const m = newMatch({ startScore: 169 });
    expect(m.view.players[0]?.checkout).toBeNull();
  });

  it('shortens the route as darts are used', () => {
    const m = newMatch({ startScore: 100 });
    play(m, 'T20');
    expect(m.view.players[0]?.checkout).toEqual(['D20']);
  });
});

describe('X01 roster changes mid-match', () => {
  it('starts a joining player on their own full score', () => {
    const m = newMatch({ startScore: 501, perPlayer: { carol: { startScore: 301 } } });
    play(m, 'T20', 'T20', 'T20');
    m.apply({ type: 'ADD_PLAYER', player: { id: 'carol', name: 'Carol', color: '#0f0' } });
    expect(scoreOf(m, 'carol')).toBe(301);
    expect(scoreOf(m, ALICE)).toBe(321);
  });

  it('does not disturb whose turn it is when someone joins', () => {
    const m = newMatch();
    play(m, 'T20');
    m.apply({ type: 'ADD_PLAYER', player: { id: 'carol', name: 'Carol', color: '#0f0' } });
    expect(m.view.activePlayerId).toBe(ALICE);
    expect(m.view.turn.throws).toHaveLength(1);
  });

  it('ignores a duplicate join', () => {
    const m = newMatch();
    m.apply({ type: 'ADD_PLAYER', player: { id: ALICE, name: 'Alice', color: '#f00' } });
    expect(m.view.players).toHaveLength(2);
  });

  it('keeps the right player active when an earlier player leaves', () => {
    const m = newMatch();
    m.apply({ type: 'ADD_PLAYER', player: { id: 'carol', name: 'Carol', color: '#0f0' } });
    play(m, 'T20', 'T20', 'T20');          // Alice done, Bob active
    expect(m.view.activePlayerId).toBe(BOB);
    m.apply({ type: 'REMOVE_PLAYER', playerId: ALICE });
    // Bob must still be the thrower, not skipped over.
    expect(m.view.activePlayerId).toBe(BOB);
    expect(m.view.players.map((p) => p.playerId)).toEqual([BOB, 'carol']);
  });

  it('ends the turn when the active player leaves mid-turn', () => {
    const m = newMatch();
    m.apply({ type: 'ADD_PLAYER', player: { id: 'carol', name: 'Carol', color: '#0f0' } });
    play(m, 'T20');
    expect(m.view.turn.throws).toHaveLength(1);
    m.apply({ type: 'REMOVE_PLAYER', playerId: ALICE });
    expect(m.view.turn.throws).toHaveLength(0);
    expect(m.view.activePlayerId).toBe(BOB);
  });

  it('ignores removing someone who is not playing', () => {
    const m = newMatch();
    m.apply({ type: 'REMOVE_PLAYER', playerId: 'nobody' });
    expect(m.view.players).toHaveLength(2);
  });

  it('replays roster changes correctly on undo', () => {
    const m = newMatch();
    m.apply({ type: 'ADD_PLAYER', player: { id: 'carol', name: 'Carol', color: '#0f0' } });
    play(m, 'T20', 'T20');
    m.apply({ type: 'UNDO' });
    expect(m.view.players).toHaveLength(3);
    expect(scoreOf(m, ALICE)).toBe(441);
  });
});

describe('X01 played to finishing places', () => {
  function threeWay(overrides: Record<string, unknown> = {}): Match {
    const m = new Match('m1', players('Alice', 'Bob', 'Carol'), {
      gameType: 'x01',
      startScore: 60,
      inMode: 'straight',
      outMode: 'double',
      legsToWin: 1,
      setsToWin: 1,
      legEnd: 'all-but-one',
      ...overrides,
    });
    m.apply({ type: 'START' });
    return m;
  }

  function placeOf(m: Match, playerId: string): number | null {
    const p = m.view.players.find((x) => x.playerId === playerId);
    return (p?.detail.place as number | null) ?? null;
  }

  it('keeps the leg going after the first player checks out', () => {
    const m = threeWay();
    play(m, 'T20');                    // Alice: 60 -> 0 on a triple, busts
    expect(scoreOf(m, ALICE)).toBe(60);
    play(m, 'D20', 'D10');             // Bob checks out 60
    expect(m.view.winnerId).toBeNull();
    expect(m.view.status).toBe('playing');
    expect(placeOf(m, BOB)).toBe(1);
  });

  it('does not give a finished player another turn', () => {
    const m = threeWay();
    m.apply({ type: 'NEXT_PLAYER' });           // Alice passes
    play(m, 'D20', 'D10');                      // Bob out first
    expect(m.view.activePlayerId).toBe('carol');
    m.apply({ type: 'NEXT_PLAYER' });           // Carol passes
    // Back round to Alice, skipping Bob entirely.
    expect(m.view.activePlayerId).toBe(ALICE);
  });

  it('ends the leg when only one player is left in', () => {
    const m = threeWay();
    play(m, 'D20', 'D10');                      // Alice 1st
    play(m, 'D20', 'D10');                      // Bob 2nd -> only Carol left
    expect(placeOf(m, ALICE)).toBe(1);
    expect(placeOf(m, BOB)).toBe(2);
    expect(m.view.status).toBe('finished');
  });

  it('awards the leg to whoever checked out first', () => {
    const m = threeWay({ legsToWin: 2 });
    play(m, 'D20', 'D10');                      // Alice 1st
    play(m, 'D20', 'D10');                      // Bob 2nd
    const alice = m.view.players.find((p) => p.playerId === ALICE);
    const bob = m.view.players.find((p) => p.playerId === BOB);
    expect(alice?.legsWon).toBe(1);
    expect(bob?.legsWon).toBe(0);
  });

  it('clears places when a new leg starts', () => {
    const m = threeWay({ legsToWin: 2 });
    play(m, 'D20', 'D10');
    play(m, 'D20', 'D10');
    expect(m.view.leg).toBe(2);
    expect(placeOf(m, ALICE)).toBeNull();
    expect(placeOf(m, BOB)).toBeNull();
    expect(scoreOf(m, ALICE)).toBe(60);
  });

  it('behaves exactly like first-out with only two players', () => {
    const m = new Match('m2', players('Alice', 'Bob'), {
      gameType: 'x01', startScore: 40, outMode: 'double',
      legsToWin: 1, setsToWin: 1, legEnd: 'all-but-one',
    });
    m.apply({ type: 'START' });
    play(m, 'D20');
    expect(m.view.winnerId).toBe(ALICE);
  });

  it('is unaffected under the default first-out rule', () => {
    const m = threeWay({ legEnd: 'first' });
    play(m, 'D20', 'D10');
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('replays correctly through undo', () => {
    const m = threeWay();
    play(m, 'D20', 'D10');                      // Alice out
    expect(placeOf(m, ALICE)).toBe(1);
    m.apply({ type: 'UNDO' });
    expect(placeOf(m, ALICE)).toBeNull();
    expect(m.view.activePlayerId).toBe(ALICE);
    expect(scoreOf(m, ALICE)).toBe(20);
  });

  it('emits a placing event for each player who finishes', () => {
    const m = threeWay();
    play(m, 'D20');
    const events = m.apply(throwCmd('D10'));
    expect(events).toContainEqual({ type: 'x01.placed', playerId: ALICE, place: 1 });
  });

  it('drops a removed player from the places list', () => {
    const m = threeWay({ legsToWin: 2 });
    play(m, 'D20', 'D10');                      // Alice 1st
    m.apply({ type: 'REMOVE_PLAYER', playerId: ALICE });
    expect(m.view.players.map((p) => p.playerId)).toEqual([BOB, 'carol']);
    expect(m.view.status).toBe('playing');
  });
});
