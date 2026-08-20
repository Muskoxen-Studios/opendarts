import { describe, it, expect, beforeEach } from 'vitest';
import { Match } from '@darts/engine';
import type { GolfConfig, MatchCommand, Player } from '@darts/schema';
import { play, players, resetDartIds } from '../../engine/src/testkit.ts';
import { analyzeMatch, type MatchAnalysis, type MatchRecord } from './analysis.ts';
import { computeGolfHandicap, countedRounds, golfRounds } from './golf.ts';
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

describe('how many rounds count', () => {
  it('counts only the best round until five are played', () => {
    expect(countedRounds(0)).toBe(0);
    expect(countedRounds(1)).toBe(1);
    expect(countedRounds(5)).toBe(1);
  });

  it('adds one more round for every further two played', () => {
    expect(countedRounds(7)).toBe(2);
    expect(countedRounds(9)).toBe(3);
  });

  it('tops out at the best eight', () => {
    expect(countedRounds(19)).toBe(8);
    expect(countedRounds(20)).toBe(8);
    expect(countedRounds(400)).toBe(8);
  });
});

describe('the golf handicap', () => {
  it('starts a player who has never played on 36', () => {
    expect(computeGolfHandicap(ALICE, []).handicap).toBe(36);
  });

  it('holds steady when a round is played exactly to handicap', () => {
    // The defining case: 18 holes off handicap 36 is personal par 6 on every
    // hole. Playing each of them to par scores 2 points a hole, i.e. 36 -- and
    // `handicap + 36 - points` hands the same 36 straight back.
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

  it('comes down when a player beats their handicap', () => {
    // Handicap 36 (personal par 6) but every hole holed with the first dart:
    // 5 points a hole over 18 holes is 90, far above the 36 that par predicts.
    const cfg: GolfConfig = { ...config(36, 18), handicaps: { alice: 36 } };
    const a = analyzeMatch(round(cfg, Array.from({ length: 18 }, (_, i) => `S${i + 1}`)));
    expect(a.golf?.points[ALICE]).toBe(90);
    expect(computeGolfHandicap(ALICE, [a]).handicap).toBe(0);
  });

  it('averages the best rounds and ignores the rest', () => {
    // Seven rounds means the best two count. Two strong rounds among five weak
    // ones must not be dragged down by the weak ones.
    const analyses: MatchAnalysis[] = [];
    // Scratch, so personal par is a bare 4 on each of the two holes.
    for (let i = 0; i < 5; i++) analyses.push(evenRound(0, 5, `weak${i}`)); // one over: 1 pt a hole
    analyses.push(evenRound(0, 4, 'strong1')); // par: 2 pts a hole
    analyses.push(evenRound(0, 4, 'strong2'));

    const result = computeGolfHandicap(ALICE, analyses);
    expect(result.rounds).toBe(7);
    expect(result.counted).toBe(2);
    // A two-hole round is judged against a par target of 4: the two par rounds
    // scored exactly that, so they were played off scratch.
    expect(result.handicap).toBe(0);
    // The five weaker rounds scored 2 and would have dragged it to 2.
    expect(golfRounds(ALICE, analyses).filter((r) => r.playedTo === 2)).toHaveLength(5);
  });

  it('looks back over at most twenty rounds', () => {
    const analyses: MatchAnalysis[] = [];
    for (let i = 0; i < 25; i++) analyses.push(evenRound(0, 5, `r${i}`));
    expect(computeGolfHandicap(ALICE, analyses).rounds).toBe(20);
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
