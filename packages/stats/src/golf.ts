import { GOLF_BASE_HANDICAP, GOLF_HOLES } from '@darts/schema';
import type { MatchAnalysis } from './analysis.ts';

/** How many past rounds are kept for display. The handicap itself only needs the last one. */
export const GOLF_HANDICAP_WINDOW = 20;
/**
 * Points over or under the par target that move the handicap by one stroke,
 * over a full 18-hole round. Shorter rounds scale it down to match -- see
 * `handicapStep`.
 */
export const GOLF_HANDICAP_STEP = 10;

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
   * What this round did to the handicap: negative brings it down.
   *
   * Every ten points clear of the par target is worth a stroke, any part of a
   * ten counting as a whole one in whichever direction it fell: 87 points off
   * an 18-hole round is 51 clear, so six strokes off, while 10 points is 26
   * short, so three back on. Over a full 18 holes the target is the familiar
   * 36; a nine-hole round is judged against 18 and against a step of five
   * points a stroke, so half a round moves the handicap by what the same
   * standard of play would have moved it over a whole one.
   */
  adjustment: number;
  /** The handicap this round leaves the player on. */
  handicapAfter: number;
}

export interface GolfHandicap {
  /** The handicap to play the next round off. */
  handicap: number;
  /** Rounds played. */
  rounds: number;
  /** The most recent rounds, newest first. */
  recent: GolfRound[];
}

function clamp(n: number): number {
  return Math.max(0, Math.min(GOLF_BASE_HANDICAP, n));
}

/**
 * Points worth a stroke over a round with this par target.
 *
 * Half a round offers half the points, so ten over nine holes is twice the
 * performance ten over eighteen is: the step shrinks with the round (5 points
 * a stroke over nine holes) and the handicap stays the full-round figure it is
 * everywhere else.
 */
export function handicapStep(parTarget: number): number {
  const holes = Math.max(1, parTarget / 2);
  return (GOLF_HANDICAP_STEP * Math.min(holes, GOLF_HOLES)) / GOLF_HOLES;
}

/** What a round's score is worth in strokes off the handicap. */
export function handicapAdjustment(points: number, parTarget: number): number {
  const margin = points - parTarget;
  if (margin === 0) return 0;
  // Rounded away from zero, so a round either side of the target always moves
  // the handicap: two points short is still a stroke back on.
  return -Math.sign(margin) * Math.ceil(Math.abs(margin) / handicapStep(parTarget));
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
    const adjustment = handicapAdjustment(points, parTarget);
    out.push({
      matchId: a.matchId,
      endedAt: a.endedAt,
      handicap,
      points,
      holesPlayed: holes.length,
      parTarget,
      adjustment,
      handicapAfter: clamp(handicap + adjustment),
    });
  }
  return out;
}

/**
 * The handicap a player carries into their next round.
 *
 * It is a running figure, not an average of past form: each round moves the
 * handicap the player went into it with, and the result carries into the next
 * one. Three good rounds in a row therefore compound. The base for a round is
 * the handicap actually played off, so a hand-corrected one is respected from
 * then on.
 *
 * A player with no rounds behind them starts on 36, which is what a full set of
 * par holes is worth. Analyses must be in chronological order.
 */
export function computeGolfHandicap(playerId: string, analyses: MatchAnalysis[]): GolfHandicap {
  const all = golfRounds(playerId, analyses);
  const last = all[all.length - 1];

  return {
    handicap: last ? last.handicapAfter : GOLF_BASE_HANDICAP,
    rounds: all.length,
    recent: all.slice(-GOLF_HANDICAP_WINDOW).reverse(),
  };
}
