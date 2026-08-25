import { describe, it, expect, beforeEach } from 'vitest';
import type { GameConfig } from '@darts/schema';
import { Match } from './match.ts';
import { play, players, resetDartIds } from './testkit.ts';

/**
 * The round limit caps how long a leg may run. Passing it ends the leg and
 * hands it to whoever the engine judges closest to winning -- the same
 * comparator END_MATCH uses -- while legsToWin and setsToWin still decide when
 * the match itself is over.
 *
 * A round is a turn each. With `roundLimit: 2` and two players, the leg ends
 * after Bob's second turn, not Alice's.
 */

const ROSTER = players('Alice', 'Bob');

beforeEach(resetDartIds);

function start(config: GameConfig): Match {
  const m = new Match('r1', ROSTER, config);
  m.apply({ type: 'START' });
  return m;
}

function legsOf(m: Match, playerId: string): number {
  return m.view.players.find((p) => p.playerId === playerId)?.legsWon ?? 0;
}

const X01: GameConfig = {
  gameType: 'x01',
  startScore: 501,
  inMode: 'straight',
  outMode: 'straight',
  legsToWin: 1,
  setsToWin: 1,
  roundLimit: 2,
  legEnd: 'first',
  perPlayer: {},
};

describe('round limit', () => {
  it('counts a round as a turn each, and does not end the leg early', () => {
    const m = start(X01);
    // Alice's first turn, then Bob's: one full round, no leg awarded yet.
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    expect(m.view.round).toBe(2);
    expect(m.view.status).toBe('playing');
  });

  it('ends the leg on the leader once the limit is passed (x01: lowest score)', () => {
    const m = start(X01);
    // Alice scores 180 twice, Bob 3 twice: Alice is furthest down.
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    expect(m.view.status).toBe('finished');
    expect(m.view.winnerId).toBe('alice');
  });

  it('starts a fresh leg rather than finishing the match when legs remain', () => {
    const m = start({ ...X01, legsToWin: 2 });
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    expect(m.view.status).toBe('playing');
    expect(legsOf(m, 'alice')).toBe(1);
    expect(m.view.leg).toBe(2);
    // The new leg resets both the scores and the round counter.
    expect(m.view.round).toBe(1);
    expect(m.view.players.map((p) => p.score)).toEqual([501, 501]);
  });

  it('does nothing at all when no limit is configured', () => {
    const m = start({ ...X01, roundLimit: null });
    for (let i = 0; i < 4; i++) play(m, '1', '1', '1', '1', '1', '1');
    expect(m.view.status).toBe('playing');
    expect(m.view.round).toBe(5);
    expect(m.view.roundLimit).toBeNull();
  });

  it('reports progress through the round in the view', () => {
    const m = start(X01);
    expect(m.view.round).toBe(1);
    expect(m.view.roundLimit).toBe(2);
    // Half a round -- only Alice has thrown -- so the counter has not moved.
    play(m, '1', '1', '1');
    expect(m.view.round).toBe(1);
  });

  it('survives a refold of the command log', () => {
    const m = start({ ...X01, legsToWin: 2 });
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    play(m, 'T20', 'T20', 'T20', '1', '1', '1');
    const rebuilt = Match.fromLog('r1', ROSTER, { ...X01, legsToWin: 2 }, [...m.log]);
    expect(rebuilt.view.leg).toBe(2);
    expect(legsOf(rebuilt, 'alice')).toBe(1);
  });
});

describe('round limit, per game', () => {
  // Two rounds of three darts each, then the leg is awarded to the leader.
  const CASES: Array<{ name: string; config: GameConfig; alice: string[]; bob: string[]; winner: string }> = [
    {
      name: 'cricket -- most marks closed',
      config: {
        gameType: 'cricket',
        variant: 'standard',
        targets: [20, 19, 18, 17, 16, 15, 25],
        scoring: true,
        legsToWin: 1,
        setsToWin: 1,
        roundLimit: 2,
      },
      alice: ['T20', 'T19', 'T18'],
      bob: ['1', '1', '1'],
      winner: 'alice',
    },
    {
      name: 'gotcha -- highest score',
      config: {
        gameType: 'gotcha',
        target: 301,
        knockback: 'zero',
        exactFinish: true,
        handicaps: {},
        legsToWin: 1,
        setsToWin: 1,
        roundLimit: 2,
      },
      alice: ['20', '20', '20'],
      bob: ['1', '1', '1'],
      winner: 'alice',
    },
    {
      name: 'shanghai -- highest total',
      config: {
        gameType: 'shanghai',
        startRound: 1,
        endRound: 7,
        instantWin: false,
        legsToWin: 1,
        setsToWin: 1,
        roundLimit: 2,
      },
      alice: ['1', '1', '1'],
      bob: ['5', '5', '5'],
      winner: 'alice',
    },
    {
      name: 'golf -- most points',
      config: {
        gameType: 'golf',
        holes: 18,
        par: 4,
        handicaps: { alice: 36, bob: 36 },
        legsToWin: 1,
        setsToWin: 1,
        roundLimit: 2,
      },
      alice: ['1', '1', '1'],
      bob: ['5', '5', '5'],
      winner: 'alice',
    },
    {
      name: 'killer -- nobody hit anything, so seat order decides',
      config: {
        gameType: 'killer',
        startingLives: 3,
        friendlyFire: false,
        handicaps: {},
        legsToWin: 1,
        setsToWin: 1,
        roundLimit: 2,
      },
      alice: ['MISS', 'MISS', 'MISS'],
      bob: ['MISS', 'MISS', 'MISS'],
      winner: 'alice',
    },
  ];

  for (const c of CASES) {
    it(`ends the leg for ${c.name}`, () => {
      const m = start(c.config);
      play(m, ...c.alice, ...c.bob);
      expect(m.view.status).toBe('playing');
      play(m, ...c.alice, ...c.bob);
      expect(m.view.status).toBe('finished');
      expect(m.view.winnerId).toBe(c.winner);
    });
  }
});
