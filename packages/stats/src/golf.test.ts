import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from '@darts/engine';
import type { GolfConfig, MatchCommand, Player } from '@darts/schema';
import { play, players, resetDartIds } from '../../engine/src/testkit.ts';
import { analyzeMatch, type MatchAnalysis, type MatchRecord } from './analysis.ts';
import { computeGolfHandicap, golfRounds, handicapAdjustment } from './golf.ts';
import { buildHeatmap, summarizeMatch } from './summary.ts';

const ROSTER: Player[] = players('Alice');
const ALICE = 'alice';

function config(handicap: number, holes = 2): GolfConfig {
  return {
    gameType: 'golf',
    holes,
    par: 4,
    handicaps: { alice: handicap },
    legsToWin: 1,
    setsToWin: 1,
    roundLimit: null,
  };
}

/**
 * Play a scripted golf round and hand back what would be persisted.
 * `script` is the dart labels for the whole round, in order.
 */
function round(cfg: GolfConfig, script: string[], id = 'g1', endedAt = '2026-01-01T12:00:00.000Z'): MatchRecord {
  const m = new Match(id, ROSTER, cfg);
  m.apply({ type: 'START' });
  play(m, ...script);
  return {
    matchId: id,
    gameType: 'golf',
    config: cfg,
    players: ROSTER,
    commands: [...m.log] as MatchCommand[],
    endedAt,
    startedAt: '2026-01-01T11:30:00.000Z',
  };
}

/** A two-hole round where every hole is holed out with the given dart count. */
function evenRound(handicap: number, strokesPerHole: number, id = 'g1'): MatchAnalysis {
  const script: string[] = [];
  for (const hole of [1, 2]) {
    for (let i = 1; i < strokesPerHole; i++) script.push('MISS');
    script.push(`S${hole}`);
  }
  return analyzeMatch(round(config(handicap), script, id));
}

beforeEach(resetDartIds);

describe('what a round is worth', () => {
  it('takes a stroke off for every ten points clear of the par target', () => {
    // The worked example: 87 points off an 18-hole round is 51 clear of 36,
    // which is ceil(51 / 10) = 6 strokes off. 10 points is 26 short: 3 back on.
    expect(handicapAdjustment(87, 36)).toBe(-6);
    expect(handicapAdjustment(10, 36)).toBe(3);
  });

  it('rounds a part-stroke away from zero in both directions', () => {
    expect(handicapAdjustment(37, 36)).toBe(-1);
    expect(handicapAdjustment(46, 36)).toBe(-1);
    expect(handicapAdjustment(47, 36)).toBe(-2);
    expect(handicapAdjustment(35, 36)).toBe(1);
    expect(handicapAdjustment(26, 36)).toBe(1);
    expect(handicapAdjustment(25, 36)).toBe(2);
  });

  it('leaves the handicap alone on exactly the par target', () => {
    expect(handicapAdjustment(36, 36)).toBe(0);
    expect(handicapAdjustment(18, 18)).toBe(0);
  });

  it('moves a nine-hole round exactly as far as the same play over eighteen', () => {
    // Half the holes offer half the points, so the target halves to 18 and the
    // step halves with it: 10 clear of 18 is the same standard of play as 20
    // clear of 36, and must be worth the same two strokes.
    expect(handicapAdjustment(28, 18)).toBe(handicapAdjustment(56, 36));
    expect(handicapAdjustment(28, 18)).toBe(-2);
    expect(handicapAdjustment(8, 18)).toBe(2);
    expect(handicapAdjustment(23, 18)).toBe(-1);
  });
});

describe('the golf handicap', () => {
  it('starts a player who has never played on 36', () => {
    expect(computeGolfHandicap(ALICE, []).handicap).toBe(36);
  });

  it('holds steady when a round is played exactly to the par target', () => {
    // The defining case: 18 holes off handicap 36 is personal par 6 on every
    // hole. Playing each of them to par scores 2 points a hole, i.e. 36 -- and
    // an on-target round moves the handicap by nothing.
    const cfg: GolfConfig = { ...config(36, 18), handicaps: { alice: 36 } };
    const script: string[] = [];
    for (let hole = 1; hole <= 18; hole++) {
      for (let i = 1; i < 6; i++) script.push('MISS');
      script.push(`S${hole}`);
    }
    const a = analyzeMatch(round(cfg, script));
    expect(a.golf?.points[ALICE]).toBe(36);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(36);
  });

  it('holds a nine-hole round steady on the same handicap an eighteen holds', () => {
    // The whole point of the shorter round: off 36 the handicap gives 18
    // strokes over nine holes, so net par is the same 6 a hole it is over
    // eighteen. Playing every hole to it scores 2 a hole -- 18, exactly the
    // nine-hole target -- and the handicap does not move.
    const cfg: GolfConfig = { ...config(36, 9), handicaps: { alice: 36 } };
    const script: string[] = [];
    for (let hole = 1; hole <= 9; hole++) {
      for (let i = 0; i < 5; i++) script.push('MISS');
      script.push(`S${hole}`);
    }
    const a = analyzeMatch(round(cfg, script, 'nine'));
    expect(a.golf?.points[ALICE]).toBe(18);
    expect(golfRounds(ALICE, [a])[0]?.parTarget).toBe(18);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(36);
  });

  it('comes down when a player beats the par target', () => {
    // Handicap 36 (personal par 6) but every hole holed with the first dart:
    // 5 points a hole over 18 holes is 90, i.e. 54 clear -- six strokes off.
    const cfg: GolfConfig = { ...config(36, 18), handicaps: { alice: 36 } };
    const a = analyzeMatch(round(cfg, Array.from({ length: 18 }, (_, i) => `S${i + 1}`)));
    expect(a.golf?.points[ALICE]).toBe(90);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(30);
  });

  it('only ever moves the handicap the round was played off', () => {
    // Two holes, par target 4, holed with the first dart each: 5 points a hole
    // is 10, six clear of the target -- which over a ninth of a round is a
    // step of 10/9 of a point, so six strokes off whatever was played off.
    const a = evenRound(20, 1, 'r1');
    expect(a.golf?.points[ALICE]).toBe(10);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(14);
  });

  it('compounds round after round rather than averaging past form', () => {
    // Three identical two-hole rounds, each one stroke better than the target.
    const analyses = [
      evenRound(36, 1, 'r1'),
      evenRound(35, 1, 'r2'),
      evenRound(34, 1, 'r3'),
    ];
    const result = computeGolfHandicap(ALICE, analyses);
    expect(analyses.map((a) => a.golf?.handicaps[ALICE])).toEqual([36, 35, 34]);
    // Each round is six clear of its target, and the last one played off 34.
    expect(result.handicap).toBe(28);
    expect(result.rounds).toBe(3);
  });

  it('pushes the handicap back up after a poor round', () => {
    // Two holes off scratch, both abandoned one over par: 0 points against a
    // target of 4 is four short, and over a ninth of a round that is four
    // strokes back on.
    const a = analyzeMatch(round(config(0), Array(2 * 5).fill('MISS'), 'bad'));
    expect(a.golf?.points[ALICE]).toBe(0);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(4);
  });

  it('never leaves the 0-36 range', () => {
    expect(computeGolfHandicap(ALICE, [evenRound(0, 1, 'floor')]).handicap).toBe(0);

    // Off 36 on two holes personal par is 22, so an abandoned hole takes 23
    // darts. Nothing scored, four short of the target -- but 36 is the ceiling.
    const a = analyzeMatch(round(config(36), Array(2 * 23).fill('MISS'), 'ceiling'));
    expect(a.golf?.points[ALICE]).toBe(0);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(36);
  });

  it('keeps at most the last twenty rounds for display', () => {
    const analyses: MatchAnalysis[] = [];
    for (let i = 0; i < 25; i++) analyses.push(evenRound(0, 5, `r${i}`));
    const result = computeGolfHandicap(ALICE, analyses);
    expect(result.rounds).toBe(25);
    expect(result.recent).toHaveLength(20);
    expect(result.recent[0]?.matchId).toBe('r24');
    expect(golfRounds(ALICE, analyses).every((r) => r.parTarget === 4)).toBe(true);
  });
});

describe('the match report', () => {
  it('records every hole on the card', () => {
    const report = summarizeMatch(evenRound(0, 2));
    const alice = report.players[0];
    expect(alice?.golf?.points).toBe(8);
    expect(alice?.golf?.holes).toHaveLength(2);
    expect(alice?.golf?.holed).toBe(2);
    expect(alice?.golf?.birdiesOrBetter).toBe(2);
  });

  it('offers the winning turn for replay', () => {
    const report = summarizeMatch(evenRound(0, 2));
    expect(report.winnerId).toBe(ALICE);
    // The turn that ended the round: the first three darts were a turn of
    // their own, so the winning turn is the single dart that holed the last hole.
    expect(report.winningTurn?.darts.map((d) => d.label)).toEqual(['S2']);
  });

  it('measures how long the match took', () => {
    const report = summarizeMatch(evenRound(0, 2));
    expect(report.durationMs).toBe(30 * 60 * 1000);
  });
});

describe('the heatmap', () => {
  it('counts segments without needing coordinates', () => {
    const map = buildHeatmap([
      { playerId: ALICE, number: 20, ring: 'TRIPLE' },
      { playerId: ALICE, number: 20, ring: 'TRIPLE' },
      { playerId: ALICE, number: 20, ring: 'SINGLE_OUTER' },
      { playerId: ALICE, number: 0, ring: 'MISS' },
    ]);
    expect(map.total).toBe(4);
    expect(map.max).toBe(2);
    expect(map.byNumber[20]).toBe(3);
    expect(map.byNumber[0]).toBe(1);
    expect(map.dots).toHaveLength(0);
    expect(map.withCoords).toBe(0);
  });

  it('plots the throws that do carry coordinates', () => {
    const map = buildHeatmap([
      { playerId: ALICE, number: 20, ring: 'TRIPLE', coords: { x: 3, y: -100 } },
      { playerId: ALICE, number: 20, ring: 'TRIPLE', coords: null },
    ]);
    expect(map.withCoords).toBe(1);
    expect(map.dots).toEqual([{ x: 3, y: -100, playerId: ALICE }]);
    // The segment count still sees both darts.
    expect(map.byNumber[20]).toBe(2);
  });
});
