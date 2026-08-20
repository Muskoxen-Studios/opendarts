import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, throwCmd } from './testkit.ts';

const [ALICE, BOB] = ['alice', 'bob'];

function newMatch(overrides: Record<string, unknown> = {}): Match {
  const m = new Match('m1', players('Alice', 'Bob'), {
    gameType: 'gotcha',
    target: 200,
    knockback: 'zero',
    exactFinish: true,
    legsToWin: 1,
    setsToWin: 1,
    ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

/** Bring both players to distinct non-zero scores over two rounds. */
function setUpKnockback(m: Match): void {
  play(m, 'T20', 'MISS', 'MISS');   // Alice 60
  play(m, '20', 'MISS', 'MISS');    // Bob 20
  play(m, '20', 'MISS', 'MISS');    // Alice 80 (turn started at 60)
}

beforeEach(resetDartIds);

describe('Gotcha counting up', () => {
  it('adds rather than subtracts', () => {
    const m = newMatch();
    play(m, 'T20', '20', 'D5');
    expect(scoreOf(m, ALICE)).toBe(90);
  });

  it('starts every player at zero', () => {
    const m = newMatch();
    expect(scoreOf(m, ALICE)).toBe(0);
    expect(scoreOf(m, BOB)).toBe(0);
  });

  it('reports the remaining distance to the target', () => {
    const m = newMatch({ target: 100 });
    play(m, 'T20');
    expect(m.view.players[0]?.detail.remaining).toBe(40);
  });
});

describe('Gotcha handicaps', () => {
  it('starts a player with a handicap on their head start instead of zero', () => {
    const m = newMatch({ target: 200, handicaps: { alice: 50 } });
    expect(scoreOf(m, ALICE)).toBe(50);
    expect(scoreOf(m, BOB)).toBe(0);
  });

  it('clamps a head start into the valid range for the target', () => {
    const m = newMatch({ target: 200, handicaps: { alice: 500 } });
    expect(scoreOf(m, ALICE)).toBe(199);
  });

  it('reverts a bust back to the handicap head start, not zero', () => {
    const m = newMatch({ target: 100, handicaps: { alice: 50 } });
    play(m, 'T20'); // 50 + 60 = 110 > 100, busts
    expect(scoreOf(m, ALICE)).toBe(50);
  });

  it('restores the handicap head start on a leg restart', () => {
    const m = newMatch({ target: 200, handicaps: { alice: 50 } });
    play(m, 'T20', 'MISS', 'MISS'); // 110
    m.apply({ type: 'RESTART_LEG' });
    expect(scoreOf(m, ALICE)).toBe(50);
  });
});

describe('Gotcha busting', () => {
  it('busts on overshoot and restores the turn-start score', () => {
    const m = newMatch({ target: 50 });
    play(m, '20', '20');
    expect(scoreOf(m, ALICE)).toBe(40);
    play(m, 'T20');
    expect(scoreOf(m, ALICE)).toBe(0);
    expect(m.view.activePlayerId).toBe(BOB);
  });

  it('keeps a bust local to the turn, not the whole leg', () => {
    const m = newMatch({ target: 100 });
    play(m, 'T20', 'MISS', 'MISS');   // 60
    play(m, 'MISS', 'MISS', 'MISS');  // Bob
    play(m, 'T20');                   // 120 > 100 -> bust back to 60
    expect(scoreOf(m, ALICE)).toBe(60);
  });

  it('allows overshoot when exactFinish is off', () => {
    const m = newMatch({ target: 50, exactFinish: false });
    play(m, 'T20');
    expect(m.view.winnerId).toBe(ALICE);
  });
});

describe('Gotcha knock-back', () => {
  it('sends the victim to zero in zero mode', () => {
    const m = newMatch({ knockback: 'zero' });
    setUpKnockback(m);
    expect(scoreOf(m, ALICE)).toBe(80);
    expect(scoreOf(m, BOB)).toBe(20);
    play(m, 'T20');   // Bob 20 + 60 = 80, landing on Alice
    expect(scoreOf(m, BOB)).toBe(80);
    expect(scoreOf(m, ALICE)).toBe(0);
  });

  it('sends the victim to their previous turn score in previousTurn mode', () => {
    const m = newMatch({ knockback: 'previousTurn' });
    setUpKnockback(m);
    play(m, 'T20');   // Bob lands on 80
    // Alice began her most recent turn on 60, so that is where she returns.
    expect(scoreOf(m, ALICE)).toBe(60);
  });

  it('emits a knockback event naming both players', () => {
    const m = newMatch({ knockback: 'zero' });
    setUpKnockback(m);
    const events = m.apply(throwCmd('T20'));
    expect(events).toContainEqual({
      type: 'gotcha.knockback',
      byPlayerId: BOB,
      victimPlayerId: ALICE,
      from: 80,
      to: 0,
    });
  });

  it('does not knock back a player sitting on zero', () => {
    const m = newMatch();
    play(m, 'MISS', 'MISS', 'MISS');   // Alice stays on 0
    play(m, 'MISS');                   // Bob also on 0, no knockback
    expect(scoreOf(m, ALICE)).toBe(0);
    const events = m.apply(throwCmd('MISS'));
    expect(events.some((e) => e.type === 'gotcha.knockback')).toBe(false);
  });

  it('does not knock back the thrower', () => {
    const m = newMatch();
    play(m, 'T20');
    expect(scoreOf(m, ALICE)).toBe(60);
  });
});

describe('Gotcha winning', () => {
  it('requires the exact target', () => {
    const m = newMatch({ target: 60 });
    play(m, 'T20');
    expect(m.view.winnerId).toBe(ALICE);
    expect(m.view.status).toBe('finished');
  });

  it('does not win by overshooting under exactFinish', () => {
    const m = newMatch({ target: 59 });
    play(m, 'T20');
    expect(m.view.winnerId).toBeNull();
    expect(scoreOf(m, ALICE)).toBe(0);
  });
});
