import { GOLF_BASE_HANDICAP } from '@darts/schema';
import type { MatchAnalysis } from './analysis.ts';

/** How many past rounds the handicap looks back over. */
export const GOLF_HANDICAP_WINDOW = 20;
/** How many of those rounds count, once a player has a full window. */
export const GOLF_HANDICAP_BEST = 8;

export interface GolfRound {
  matchId: string;
  endedAt: string | null;
  /** The handicap the player played this round off. */
  handicap: number;
  points: number;
  holesPlayed: number;
  /** What playing every hole of this round to par would have scored. */
  parTarget: number;
  /**
   * The handicap this round was actually played to.
   *
   * Playing every hole to personal par scores two points a hole, so the round's
   * own verdict is `handicap + parTarget - points`: beat par and it comes out
   * lower. Over a full 18 holes the target is the familiar 36; a nine-hole
   * round is judged against 18, so short rounds stay comparable rather than
   * inflating everybody's handicap.
   */
  playedTo: number;
}

export interface GolfHandicap {
  /** The handicap to play the next round off. */
  handicap: number;
  /** Rounds available in the window. */
  rounds: number;
  /** How many of them the handicap is averaged over. */
  counted: number;
  /** The rounds in the window, newest first. */
  recent: GolfRound[];
}

/**
 * How many rounds count toward the handicap.
 *
 * The target is the best 8 of the last 20. With fewer rounds behind you only a
 * proportional slice counts: the best single round up to five rounds played,
 * then one more for every further two rounds, reaching eight at a full window.
 * Averaging over a wide field too early would peg a newcomer to their worst
 * night out.
 */
export function countedRounds(rounds: number): number {
  if (rounds <= 0) return 0;
  return Math.min(GOLF_HANDICAP_BEST, 1 + Math.floor(Math.max(0, rounds - 5) / 2));
}

function clamp(n: number): number {
  return Math.max(0, Math.min(GOLF_BASE_HANDICAP, n));
}

/** Every golf round this player completed, oldest first. */
export function golfRounds(playerId: string, analyses: MatchAnalysis[]): GolfRound[] {
  const out: GolfRound[] = [];
  for (const a of analyses) {
    if (a.gameType !== 'golf' || !a.golf) continue;
    if (!a.players.some((p) => p.id === playerId)) continue;
    const holes = a.golf.holes[playerId] ?? [];
    if (holes.length === 0) continue;
    const handicap = a.golf.handicaps[playerId] ?? GOLF_BASE_HANDICAP;
    const points = a.golf.points[playerId] ?? 0;
    // The round the match was set up as, not the holes actually reached: a
    // round abandoned half way through should read as the poor round it was.
    const parTarget = 2 * (a.golf.holeCount || holes.length);
    out.push({
      matchId: a.matchId,
      endedAt: a.endedAt,
      handicap,
      points,
      holesPlayed: holes.length,
      parTarget,
      playedTo: clamp(handicap + parTarget - points),
    });
  }
  return out;
}

/**
 * The handicap a player carries into their next round.
 *
 * A player with no rounds behind them starts on 36, which is what a full set of
 * par holes is worth. Analyses must be in chronological order.
 */
export function computeGolfHandicap(playerId: string, analyses: MatchAnalysis[]): GolfHandicap {
  const all = golfRounds(playerId, analyses);
  const window = all.slice(-GOLF_HANDICAP_WINDOW);
  const counted = countedRounds(window.length);

  if (counted === 0) {
    return { handicap: GOLF_BASE_HANDICAP, rounds: 0, counted: 0, recent: [] };
  }

  const best = [...window].sort((a, b) => a.playedTo - b.playedTo).slice(0, counted);
  const mean = best.reduce((sum, r) => sum + r.playedTo, 0) / best.length;

  return {
    handicap: clamp(Math.round(mean)),
    rounds: window.length,
    counted,
    recent: [...window].reverse(),
  };
}
