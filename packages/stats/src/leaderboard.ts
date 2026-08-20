import type { GolfHoleResult } from '@darts/engine';
import type { MatchAnalysis } from './analysis.ts';
import { computeCareer, type CareerStats } from './career.ts';
import { buildHeatmap, type Heatmap } from './summary.ts';

/**
 * How a match converts into ranking points.
 *
 * Turning up is worth something and winning is worth more, so a player who
 * plays twice as often as everyone else is not overtaken by someone who played
 * once and won. Win rate alone would do the opposite: a single lucky match
 * would top the table forever.
 */
export const LEADERBOARD_POINTS = { win: 3, played: 1 } as const;

export function leaderboardPoints(matchesPlayed: number, matchesWon: number): number {
  return matchesWon * LEADERBOARD_POINTS.win + (matchesPlayed - matchesWon) * LEADERBOARD_POINTS.played;
}

/**
 * One player's line on the table.
 *
 * The career fields are exactly `CareerStats`, folded over the same analyses
 * the profile page uses, so a player's own page and their row here can never
 * disagree. What is added on top is the ranking, the match-shaped figures that
 * career stats do not carry (best turn, busted turns) and the heatmap.
 */
export interface LeaderboardRow {
  rank: number;
  playerId: string;
  name: string;
  color: string;
  /** Ranking points; see LEADERBOARD_POINTS. */
  points: number;

  matchesPlayed: number;
  matchesWon: number;
  winRate: number | null;
  legsWon: number;
  dartsThrown: number;

  average3: number | null;
  first9Average: number | null;
  /** Highest three-dart turn, across every game that scores in points. */
  bestTurn: number | null;
  count180: number;
  count140plus: number;
  count100plus: number;

  checkoutsHit: number;
  checkoutRate: number | null;
  highestCheckout: number;
  bestLegDarts: number | null;
  /** Turns that busted, across every game with a bust rule. */
  bustedTurns: number;

  mpr: number | null;

  golfRounds: number;
  golfBestPoints: number | null;
  golfHandicap: number;
  /** The card of the player's best Stableford round, hole by hole. */
  golfBestCard: GolfHoleResult[] | null;

  shanghaiRounds: number;
  shanghaiBestScore: number | null;

  currentStreak: number;
  longestStreak: number;

  /** When this player last finished a match, so a stale row is visible as one. */
  lastPlayed: string | null;

  heatmap: Heatmap;
}

export interface Leaderboard {
  /** ISO timestamp the table counts from; null means "everything on record". */
  since: string | null;
  generatedAt: string;
  matchesCounted: number;
  rows: LeaderboardRow[];
  /** Every counted dart, for the table's own heatmap. */
  heatmap: Heatmap;
}

export interface LeaderboardOptions {
  /**
   * Restrict the table to these players. The server passes the profiles that
   * still exist, so a deleted player drops off the table while their matches --
   * and everyone else's statistics from those matches -- stay intact.
   */
  include?: ReadonlySet<string>;
  /** Stamped onto the result; the caller has already filtered the analyses. */
  since?: string | null;
  /**
   * Golf handicaps to show instead of the ones these analyses imply.
   *
   * A leaderboard may cover a slice of history -- one season -- but a player's
   * handicap is not a seasonal figure: it is the one they would carry into
   * their next round, derived from every round they have ever played. Showing a
   * season-local handicap would print a number they will never play off.
   */
  handicaps?: ReadonlyMap<string, number>;
}

/**
 * Rank every player over the supplied matches.
 *
 * Analyses must be chronological, because `computeCareer` derives streaks from
 * their order.
 */
export function computeLeaderboard(
  analyses: readonly MatchAnalysis[],
  opts: LeaderboardOptions = {},
): Leaderboard {
  const list = [...analyses];
  const seen = new Map<string, { name: string; color: string }>();
  for (const a of list) {
    for (const p of a.players) {
      if (opts.include && !opts.include.has(p.id)) continue;
      // Last appearance wins: names and colours are read from the profile at
      // load time, so the most recent match carries the current one.
      seen.set(p.id, { name: p.name, color: p.color });
    }
  }

  const rows: LeaderboardRow[] = [];
  for (const [playerId, who] of seen) {
    const career = computeCareer(playerId, list);
    rows.push({
      rank: 0,
      playerId,
      name: who.name,
      color: who.color,
      points: leaderboardPoints(career.matchesPlayed, career.matchesWon),
      ...pick(career),
      golfHandicap: opts.handicaps?.get(playerId) ?? career.golfHandicap,
      ...foldTurns(list, playerId),
      ...bestGolfCard(list, playerId),
      lastPlayed: lastPlayedAt(list, playerId),
      heatmap: buildHeatmap(list.flatMap((a) => a.throws.filter((t) => t.playerId === playerId))),
    });
  }

  rows.sort(compareRows);
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  return {
    since: opts.since ?? null,
    generatedAt: new Date().toISOString(),
    matchesCounted: list.length,
    rows,
    heatmap: buildHeatmap(
      list.flatMap((a) =>
        opts.include ? a.throws.filter((t) => opts.include!.has(t.playerId)) : a.throws,
      ),
    ),
  };
}

/**
 * Ranking order: points first, then the tie-breaks a darts player would use.
 *
 * Every comparison is total, so the table is stable across reloads rather than
 * shuffling equal rows around.
 */
function compareRows(a: LeaderboardRow, b: LeaderboardRow): number {
  return (
    b.points - a.points ||
    (b.winRate ?? 0) - (a.winRate ?? 0) ||
    (b.average3 ?? 0) - (a.average3 ?? 0) ||
    b.legsWon - a.legsWon ||
    a.name.localeCompare(b.name)
  );
}

/** The career figures the table shows, lifted verbatim. */
function pick(c: CareerStats) {
  return {
    matchesPlayed: c.matchesPlayed,
    matchesWon: c.matchesWon,
    winRate: c.winRate,
    legsWon: c.legsWon,
    dartsThrown: c.dartsThrown,
    average3: c.average3,
    first9Average: c.first9Average,
    count180: c.count180,
    count140plus: c.count140plus,
    count100plus: c.count100plus,
    checkoutsHit: c.checkoutsHit,
    checkoutRate: c.checkoutRate,
    highestCheckout: c.highestCheckout,
    bestLegDarts: c.bestLegDarts,
    mpr: c.mpr,
    golfRounds: c.golfRounds,
    golfBestPoints: c.golfBestPoints,
    golfHandicap: c.golfHandicap,
    shanghaiRounds: c.shanghaiRounds,
    shanghaiBestScore: c.shanghaiBestScore,
    currentStreak: c.currentStreak,
    longestStreak: c.longestStreak,
  };
}

/**
 * Best turn and busted turns.
 *
 * Not in `CareerStats` because they are per-turn figures the match overview
 * computes and the career fold does not, and the table shows both.
 */
function foldTurns(
  analyses: readonly MatchAnalysis[],
  playerId: string,
): { bestTurn: number | null; bustedTurns: number } {
  let bestTurn: number | null = null;
  let bustedTurns = 0;
  for (const a of analyses) {
    for (const t of a.turns) {
      if (t.playerId !== playerId) continue;
      if (t.busted) {
        bustedTurns += 1;
        continue;
      }
      bestTurn = bestTurn === null ? t.total : Math.max(bestTurn, t.total);
    }
  }
  return { bestTurn, bustedTurns };
}

/** The card of the player's highest-scoring golf round. */
function bestGolfCard(
  analyses: readonly MatchAnalysis[],
  playerId: string,
): { golfBestCard: GolfHoleResult[] | null } {
  let best: { points: number; card: GolfHoleResult[] } | null = null;
  for (const a of analyses) {
    if (a.gameType !== 'golf' || !a.golf) continue;
    const card = a.golf.holes[playerId];
    if (!card || card.length === 0) continue;
    const points = a.golf.points[playerId] ?? 0;
    if (!best || points > best.points) best = { points, card };
  }
  return { golfBestCard: best?.card ?? null };
}

function lastPlayedAt(analyses: readonly MatchAnalysis[], playerId: string): string | null {
  let latest: string | null = null;
  for (const a of analyses) {
    if (!a.endedAt || !a.players.some((p) => p.id === playerId)) continue;
    if (latest === null || a.endedAt > latest) latest = a.endedAt;
  }
  return latest;
}

/**
 * The condensed form kept when a leaderboard is archived.
 *
 * Deliberately narrower than `LeaderboardRow`: the heatmap and the golf card
 * are the bulky parts and both are derivable from the command log, which the
 * archive does not replace. What is kept is what a past season is *read* for --
 * who was there, how they placed, and how they threw.
 */
export interface ArchivedRow {
  rank: number;
  playerId: string;
  name: string;
  color: string;
  points: number;
  matchesPlayed: number;
  matchesWon: number;
  winRate: number | null;
  legsWon: number;
  dartsThrown: number;
  average3: number | null;
  first9Average: number | null;
  bestTurn: number | null;
  count180: number;
  checkoutsHit: number;
  checkoutRate: number | null;
  highestCheckout: number;
  bustedTurns: number;
  mpr: number | null;
  golfRounds: number;
  golfBestPoints: number | null;
  golfHandicap: number;
  longestStreak: number;
}

export function condenseRow(row: LeaderboardRow): ArchivedRow {
  return {
    rank: row.rank,
    playerId: row.playerId,
    name: row.name,
    color: row.color,
    points: row.points,
    matchesPlayed: row.matchesPlayed,
    matchesWon: row.matchesWon,
    winRate: row.winRate,
    legsWon: row.legsWon,
    dartsThrown: row.dartsThrown,
    average3: row.average3,
    first9Average: row.first9Average,
    bestTurn: row.bestTurn,
    count180: row.count180,
    checkoutsHit: row.checkoutsHit,
    checkoutRate: row.checkoutRate,
    highestCheckout: row.highestCheckout,
    bustedTurns: row.bustedTurns,
    mpr: row.mpr,
    golfRounds: row.golfRounds,
    golfBestPoints: row.golfBestPoints,
    golfHandicap: row.golfHandicap,
    longestStreak: row.longestStreak,
  };
}
