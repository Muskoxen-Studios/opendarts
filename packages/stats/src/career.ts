import { GOLF_BASE_HANDICAP } from '@darts/schema';
import type { MatchAnalysis } from './analysis.ts';
import { computeGolfHandicap } from './golf.ts';

export interface CareerStats {
  playerId: string;

  matchesPlayed: number;
  matchesWon: number;
  winRate: number | null;
  legsPlayed: number;
  legsWon: number;
  dartsThrown: number;

  // X01
  /** Points per three darts across all counted X01 darts. */
  average3: number | null;
  /** Average over the first nine darts of each leg. */
  first9Average: number | null;
  count180: number;
  count140plus: number;
  count100plus: number;
  /** Fewest darts used to win a leg. */
  bestLegDarts: number | null;
  highestCheckout: number;
  checkoutsHit: number;
  /**
   * Darts thrown while a checkout was available. Used as the denominator for
   * checkout percentage. This is the "darts at a finish" definition rather than
   * the stricter "darts at a double", because we cannot know where a player
   * aimed -- only what was reachable.
   */
  checkoutDarts: number;
  checkoutRate: number | null;

  // Cricket
  cricketMarks: number;
  cricketRounds: number;
  mpr: number | null;

  // Gotcha
  knockbacksDealt: number;
  knockbacksReceived: number;

  // Golf
  golfRounds: number;
  /** Best Stableford round, in points. */
  golfBestPoints: number | null;
  /** The handicap the next round would be played off. */
  golfHandicap: number;

  // Cross-game
  currentStreak: number;
  longestStreak: number;
  /** opponentId -> { won, lost } */
  headToHead: Record<string, { won: number; lost: number }>;
}

export function emptyCareer(playerId: string): CareerStats {
  return {
    playerId,
    matchesPlayed: 0,
    matchesWon: 0,
    winRate: null,
    legsPlayed: 0,
    legsWon: 0,
    dartsThrown: 0,
    average3: null,
    first9Average: null,
    count180: 0,
    count140plus: 0,
    count100plus: 0,
    bestLegDarts: null,
    highestCheckout: 0,
    checkoutsHit: 0,
    checkoutDarts: 0,
    checkoutRate: null,
    cricketMarks: 0,
    cricketRounds: 0,
    mpr: null,
    knockbacksDealt: 0,
    knockbacksReceived: 0,
    golfRounds: 0,
    golfBestPoints: null,
    golfHandicap: GOLF_BASE_HANDICAP,
    currentStreak: 0,
    longestStreak: 0,
    headToHead: {},
  };
}

interface Accum {
  x01Points: number;
  x01Darts: number;
  first9Points: number;
  first9Darts: number;
}

/**
 * Fold match analyses into career statistics for one player.
 *
 * Analyses must be supplied in chronological order, because streaks depend on
 * it. Everything else is order-independent.
 */
export function computeCareer(playerId: string, analyses: MatchAnalysis[]): CareerStats {
  const stats = emptyCareer(playerId);
  const acc: Accum = { x01Points: 0, x01Darts: 0, first9Points: 0, first9Darts: 0 };

  for (const a of analyses) {
    if (!a.players.some((p) => p.id === playerId)) continue;

    stats.matchesPlayed += 1;
    const won = a.winnerId === playerId;
    if (won) stats.matchesWon += 1;

    // Streaks
    if (won) {
      stats.currentStreak += 1;
      stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
    } else if (a.winnerId !== null) {
      stats.currentStreak = 0;
    }

    // Head to head, only meaningful once the match has a winner
    if (a.winnerId !== null) {
      for (const opp of a.players) {
        if (opp.id === playerId) continue;
        const row = stats.headToHead[opp.id] ?? { won: 0, lost: 0 };
        if (won) row.won += 1;
        else if (a.winnerId === opp.id) row.lost += 1;
        stats.headToHead[opp.id] = row;
      }
    }

    stats.legsWon += a.legsWon[playerId] ?? 0;
    stats.legsPlayed += a.legsPlayed;

    const myThrows = a.throws.filter((t) => t.playerId === playerId);
    stats.dartsThrown += myThrows.length;

    if (a.gameType === 'x01') {
      for (const t of myThrows) {
        if (t.hadCheckout) stats.checkoutDarts += 1;
      }

      const myTurns = a.turns.filter((t) => t.playerId === playerId);
      for (const t of myTurns) {
        // Averages are computed per turn, not per dart. A busted turn scores
        // nothing, so its darts count toward the denominator while its points
        // do not -- which is how a three-dart average is conventionally read.
        acc.x01Points += t.busted ? 0 : t.total;
        acc.x01Darts += t.darts;

        if (t.busted) continue;
        if (t.total === 180) stats.count180 += 1;
        if (t.total >= 140) stats.count140plus += 1;
        if (t.total >= 100) stats.count100plus += 1;
      }

      // First nine: the opening three turns of each leg.
      const byLeg = new Map<number, typeof myTurns>();
      for (const t of myTurns) {
        const list = byLeg.get(t.leg) ?? [];
        list.push(t);
        byLeg.set(t.leg, list);
      }
      for (const turns of byLeg.values()) {
        for (const t of turns.slice(0, 3)) {
          if (t.busted) {
            acc.first9Darts += t.darts;
            continue;
          }
          acc.first9Points += t.total;
          acc.first9Darts += t.darts;
        }
      }

      for (const c of a.checkouts) {
        if (c.playerId !== playerId) continue;
        stats.checkoutsHit += 1;
        stats.highestCheckout = Math.max(stats.highestCheckout, c.from);
        stats.bestLegDarts =
          stats.bestLegDarts === null ? c.darts : Math.min(stats.bestLegDarts, c.darts);
      }
    }

    if (a.gameType === 'cricket') {
      stats.cricketMarks += a.cricketMarks[playerId] ?? 0;
      stats.cricketRounds += myThrows.length / 3;
    }

    if (a.gameType === 'golf' && a.golf) {
      const points = a.golf.points[playerId];
      if (typeof points === 'number' && (a.golf.holes[playerId]?.length ?? 0) > 0) {
        stats.golfRounds += 1;
        stats.golfBestPoints = Math.max(stats.golfBestPoints ?? 0, points);
      }
    }

    for (const k of a.knockbacks) {
      if (k.byPlayerId === playerId) stats.knockbacksDealt += 1;
      if (k.victimPlayerId === playerId) stats.knockbacksReceived += 1;
    }
  }

  stats.winRate = stats.matchesPlayed > 0 ? stats.matchesWon / stats.matchesPlayed : null;
  stats.average3 = acc.x01Darts > 0 ? (acc.x01Points / acc.x01Darts) * 3 : null;
  stats.first9Average = acc.first9Darts > 0 ? (acc.first9Points / acc.first9Darts) * 3 : null;
  stats.mpr = stats.cricketRounds > 0 ? stats.cricketMarks / stats.cricketRounds : null;
  stats.checkoutRate =
    stats.checkoutDarts > 0 ? stats.checkoutsHit / stats.checkoutDarts : null;
  // The handicap is a projection of past rounds like everything else here, so
  // it recomputes on every rebuild rather than being carried on the profile.
  stats.golfHandicap = computeGolfHandicap(playerId, analyses).handicap;

  return stats;
}

/** Per-match summary for one player, used by the scoreboard and match history. */
export function matchAverage(a: MatchAnalysis, playerId: string): number | null {
  if (a.gameType !== 'x01') return null;
  const mine = a.throws.filter((t) => t.playerId === playerId);
  if (mine.length === 0) return null;
  const points = mine.reduce((sum, t) => sum + t.counted, 0);
  return (points / mine.length) * 3;
}
