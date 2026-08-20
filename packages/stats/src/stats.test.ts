import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from '@darts/engine';
import type { GameConfig, MatchCommand, Player } from '@darts/schema';
import { play, players, resetDartIds } from '../../engine/src/testkit.ts';
import { analyzeMatch, type MatchAnalysis, type MatchRecord } from './analysis.ts';
import { computeCareer } from './career.ts';
import { CATALOGUE } from './achievements/catalogue.ts';
import { backfillPlayer, evaluateMatch } from './achievements/evaluate.ts';
import type { Achievement } from './achievements/types.ts';

const ROSTER: Player[] = players('Alice', 'Bob');
const [ALICE, BOB] = ['alice', 'bob'];

/** Play a scripted match and return it in the form it would be persisted. */
function record(config: GameConfig, script: string[], endedAt = '2026-01-01T12:00:00.000Z'): MatchRecord {
  const m = new Match('m1', ROSTER, config);
  m.apply({ type: 'START' });
  play(m, ...script);
  return {
    matchId: 'm1',
    gameType: config.gameType,
    config,
    players: ROSTER,
    commands: [...m.log] as MatchCommand[],
    endedAt,
  };
}

const X01: GameConfig = {
  gameType: 'x01',
  startScore: 501,
  inMode: 'straight',
  outMode: 'double',
  legsToWin: 1,
  setsToWin: 1,
  legEnd: 'first',
  perPlayer: {},
};

/**
 * Turn the darts one player throws into a full match script by inserting the
 * opponent's (missed) turns. Without this the labels silently belong to
 * whoever the engine handed over to.
 */
function solo(labels: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < labels.length; i += 3) {
    out.push(...labels.slice(i, i + 3));
    if (i + 3 < labels.length) out.push('MISS', 'MISS', 'MISS');
  }
  return out;
}

/** A nine-dart leg: 180, 180, then 141 out. */
const NINE_DARTER = solo(['T20', 'T20', 'T20', 'T20', 'T20', 'T20', 'T20', 'T19', 'D12']);

function alice(a: MatchAnalysis) {
  return a.throws.filter((t) => t.playerId === ALICE);
}

beforeEach(resetDartIds);

describe('match analysis', () => {
  it('records every dart with the player who threw it', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    expect(a.throws).toHaveLength(15);        // 9 from Alice, 6 misses from Bob
    expect(alice(a)).toHaveLength(9);
  });

  it('groups darts into turns', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    const mine = a.turns.filter((t) => t.playerId === ALICE);
    expect(mine.map((t) => t.total)).toEqual([180, 180, 141]);
  });

  it('captures the score each dart was thrown at', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    const mine = alice(a);
    expect(mine[0]?.scoreBefore).toBe(501);
    expect(mine[3]?.scoreBefore).toBe(321);
    expect(mine.at(-1)?.scoreBefore).toBe(24);
  });

  it('records the checkout with the score it was taken from', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    expect(a.checkouts).toHaveLength(1);
    expect(a.checkouts[0]).toMatchObject({ playerId: ALICE, darts: 9, finisher: 'D12', from: 141 });
  });

  it('identifies the winner', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    expect(a.winnerId).toBe(ALICE);
  });

  it('marks busted turns', () => {
    const a = analyzeMatch(record({ ...X01, startScore: 41 }, ['20', '20']));
    const busted = a.turns.filter((t) => t.busted);
    expect(busted).toHaveLength(1);
    expect(busted[0]?.total).toBe(0);
  });
});

describe('career statistics', () => {
  it('computes a three-dart average', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    const c = computeCareer(ALICE, [a]);
    expect(c.average3).toBeCloseTo((501 / 9) * 3);
    expect(c.dartsThrown).toBe(9);
  });

  it('gives the opponent who only missed an average of zero', () => {
    const c = computeCareer(BOB, [analyzeMatch(record(X01, NINE_DARTER))]);
    expect(c.average3).toBe(0);
    expect(c.dartsThrown).toBe(6);
  });

  it('counts maximums and other high turns', () => {
    const c = computeCareer(ALICE, [analyzeMatch(record(X01, NINE_DARTER))]);
    expect(c.count180).toBe(2);
    expect(c.count140plus).toBe(3);
    expect(c.count100plus).toBe(3);
  });

  it('tracks the best leg and highest checkout', () => {
    const c = computeCareer(ALICE, [analyzeMatch(record(X01, NINE_DARTER))]);
    expect(c.bestLegDarts).toBe(9);
    expect(c.highestCheckout).toBe(141);
  });

  it('excludes busted turns from the average', () => {
    const a = analyzeMatch(record({ ...X01, startScore: 41 }, ['20', '20']));
    const c = computeCareer(ALICE, [a]);
    expect(c.average3).toBe(0);
  });

  it('accumulates across matches and tracks streaks', () => {
    const one = analyzeMatch(record(X01, NINE_DARTER));
    const c = computeCareer(ALICE, [one, one, one]);
    expect(c.matchesPlayed).toBe(3);
    expect(c.matchesWon).toBe(3);
    expect(c.winRate).toBe(1);
    expect(c.longestStreak).toBe(3);
  });

  it('builds head-to-head records', () => {
    const won = analyzeMatch(record(X01, NINE_DARTER));
    const c = computeCareer(ALICE, [won, won]);
    expect(c.headToHead[BOB]).toEqual({ won: 2, lost: 0 });
    const bobs = computeCareer(BOB, [won, won]);
    expect(bobs.headToHead[ALICE]).toEqual({ won: 0, lost: 2 });
  });

  it('counts gotcha knockbacks on both sides', () => {
    const cfg: GameConfig = {
      gameType: 'gotcha', target: 200, knockback: 'zero', exactFinish: true,
      legsToWin: 1, setsToWin: 1,
    };
    const a = analyzeMatch(record(cfg, [
      'T20', 'MISS', 'MISS',    // Alice 60
      '20', 'MISS', 'MISS',     // Bob 20
      '20', 'MISS', 'MISS',     // Alice 80
      'T20',                    // Bob lands on 80 -> knocks Alice back
    ]));
    expect(computeCareer(BOB, [a]).knockbacksDealt).toBe(1);
    expect(computeCareer(ALICE, [a]).knockbacksReceived).toBe(1);
  });
});

describe('achievements', () => {
  function unlockedIds(analyses: MatchAnalysis[], playerId = ALICE): string[] {
    return backfillPlayer(playerId, analyses)
      .filter((u) => u.unlockedAt !== null)
      .map((u) => u.achievementId);
  }

  it('unlocks Maximum after a 180', () => {
    expect(unlockedIds([analyzeMatch(record(X01, NINE_DARTER))])).toContain('maximum');
  });

  it('unlocks Nine Darter for a nine-dart 501 leg', () => {
    expect(unlockedIds([analyzeMatch(record(X01, NINE_DARTER))])).toContain('nine-darter');
  });

  it('does not unlock Nine Darter for a slower leg', () => {
    const slow = record(X01, solo([
      'T20', 'T20', 'T20',
      'T20', 'T20', 'T20',
      'T20', 'T19', 'MISS',
      'MISS', 'MISS', 'D12',
    ]));
    expect(unlockedIds([analyzeMatch(slow)])).not.toContain('nine-darter');
  });

  it('reports progress on threshold achievements', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));
    const club = backfillPlayer(ALICE, [a]).find((u) => u.achievementId === 'ton-80-club');
    expect(club).toMatchObject({ unlockedAt: null, progress: 2, goal: 10 });
  });

  it('unlocks Ton-80 Club once ten maximums accumulate', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER));   // 2 maximums each
    expect(unlockedIds([a, a, a, a, a])).toContain('ton-80-club');
  });

  it('unlocks Big Fish only on a 170 finish', () => {
    // 501 -> 321 -> 170, then the maximum 170 finish.
    const bigFish = record(X01, solo([
      'T20', 'T20', 'T20',
      'T20', 'T17', 'D20',
      'T20', 'T20', 'BULL',
    ]));
    expect(unlockedIds([analyzeMatch(bigFish)])).toContain('big-fish');
    expect(unlockedIds([analyzeMatch(record(X01, NINE_DARTER))])).not.toContain('big-fish');
  });

  it('unlocks Shanghai for a single, double and triple of one number', () => {
    const shanghai = record({ ...X01, outMode: 'straight' }, ['S20', 'D20', 'T20']);   // one turn
    expect(unlockedIds([analyzeMatch(shanghai)])).toContain('shanghai');
  });

  it('excludes coordinate-dependent achievements by default', () => {
    const ids = backfillPlayer(ALICE, [analyzeMatch(record(X01, NINE_DARTER))]).map(
      (u) => u.achievementId,
    );
    expect(ids).not.toContain('tight-grouping');
    expect(ids).not.toContain('robin-hood');
  });

  it('includes them once coordinates are enabled', () => {
    const ids = backfillPlayer(ALICE, [analyzeMatch(record(X01, NINE_DARTER))], {
      coordsEnabled: true,
    }).map((u) => u.achievementId);
    expect(ids).toContain('tight-grouping');
  });

  it('stamps the unlock with the match it happened in', () => {
    const a = analyzeMatch(record(X01, NINE_DARTER, '2026-03-04T10:00:00.000Z'));
    const max = backfillPlayer(ALICE, [a]).find((u) => u.achievementId === 'maximum');
    expect(max?.unlockedAt).toBe('2026-03-04T10:00:00.000Z');
  });

  it('keeps the earliest unlock across a history', () => {
    const first = analyzeMatch(record(X01, NINE_DARTER, '2026-01-01T00:00:00.000Z'));
    const later = analyzeMatch(record(X01, NINE_DARTER, '2026-06-01T00:00:00.000Z'));
    const max = backfillPlayer(ALICE, [first, later]).find((u) => u.achievementId === 'maximum');
    expect(max?.unlockedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('catalogue goals', () => {
  it('declares a target for every progress-tracked achievement', () => {
    // Without a static goal, a player who has never thrown sees "0 / 1"
    // on every progress bar, because the real target only exists as an
    // output of evaluate().
    for (const a of CATALOGUE) {
      const sample = a.evaluate({
        playerId: 'nobody',
        match: analyzeMatch(record(X01, [])),
        career: computeCareer('nobody', []),
      });
      if ((sample.goal ?? 1) > 1) {
        expect(a.goal, `${a.id} should declare a static goal`).toBe(sample.goal);
      }
    }
  });
});

describe('backfill of a newly added achievement', () => {
  it('unlocks retroactively against matches played before it existed', () => {
    // History is played first, with the stock catalogue.
    const history = [
      analyzeMatch(record(X01, NINE_DARTER, '2026-01-01T00:00:00.000Z')),
      analyzeMatch(record(X01, NINE_DARTER, '2026-01-02T00:00:00.000Z')),
    ];
    const before = backfillPlayer(ALICE, history).map((u) => u.achievementId);
    expect(before).not.toContain('late-addition');

    // Later, a new achievement is written and added to the catalogue.
    const perfectStart: Achievement = {
      id: 'late-addition',
      name: 'Late Addition',
      description: 'An achievement written after the history was played.',
      icon: '\u{1F680}',
      evaluate: ({ playerId, match }) => ({
        unlocked: match.turns.some(
          (t) => t.playerId === playerId && t.total === 180 && t.leg === 1,
        ),
      }),
    };

    const after = backfillPlayer(ALICE, history, {
      catalogue: [...CATALOGUE, perfectStart],
    });
    const unlocked = after.find((u) => u.achievementId === 'late-addition');

    // It unlocks, and is dated to the first historical match that satisfied it
    // -- not to the day the achievement was written.
    expect(unlocked?.unlockedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
