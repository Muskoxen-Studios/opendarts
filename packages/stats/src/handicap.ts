import type { GameType } from '@darts/schema';
import type { MatchAnalysis } from './analysis.ts';

/** How many past matches the skill signal looks back over. */
export const HANDICAP_WINDOW = 20;
/** How many of those matches count, once a player has a full window. */
export const HANDICAP_BEST = 8;
/**
 * The 3-dart average a "scratch" player throws.
 *
 * A player at or above this gets no adjustment; only players below it are
 * eased -- a strong player floors at no adjustment and is never punished
 * further.
 */
export const HANDICAP_REFERENCE_AVG = 40;
/** Floor an average is clamped to before it is divided by, so a single bad match cannot blow up the mapping. */
const MIN_AVG_FLOOR = 1;

export interface SkillAverage {
  /** This player's average 3-dart value over the counted window, or null with no history at all. */
  avg: number | null;
  /** Matches available in the window. */
  matches: number;
  /** How many of them the average is taken over. */
  counted: number;
}

export interface ModeHandicap {
  /** The suggested value for this mode's own knob (start score, head start, or lives). */
  handicap: number;
  /** Matches available in the window. */
  matches: number;
  /** How many of them the underlying skill average is taken over. */
  counted: number;
}

/**
 * How many matches count toward the skill average.
 *
 * A proportional ramp-up: the best single match up to five played, then one
 * more for every further two, reaching eight at a full window.
 */
function countedMatches(matches: number): number {
  if (matches <= 0) return 0;
  return Math.min(HANDICAP_BEST, 1 + Math.floor(Math.max(0, matches - 5) / 2));
}

function roundToStep(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * A player's dart-throwing skill, as a 3-dart-average-style number, averaged
 * over the best of a recent window.
 *
 * Portable across differently configured matches of the same game type -- it
 * is purely about how hard the player throws, not what target they played to.
 */
export function skillAverage(playerId: string, analyses: MatchAnalysis[], gameType: GameType): SkillAverage {
  const perMatch: number[] = [];
  for (const a of analyses) {
    if (a.gameType !== gameType) continue;
    if (!a.players.some((p) => p.id === playerId)) continue;
    const throws = a.throws.filter((t) => t.playerId === playerId);
    if (throws.length === 0) continue;
    const mean = throws.reduce((sum, t) => sum + t.value, 0) / throws.length;
    perMatch.push(mean * 3);
  }

  const window = perMatch.slice(-HANDICAP_WINDOW);
  const counted = countedMatches(window.length);
  if (counted === 0) return { avg: null, matches: 0, counted: 0 };

  const best = [...window].sort((a, b) => b - a).slice(0, counted);
  const avg = best.reduce((sum, v) => sum + v, 0) / best.length;
  return { avg, matches: window.length, counted };
}

/**
 * X01's handicap is a suggested start score: weaker players start lower, so a
 * shorter game evens out a stronger opponent's better average.
 */
export function computeX01Handicap(
  playerId: string,
  analyses: MatchAnalysis[],
  baseStartScore: number,
): ModeHandicap {
  const { avg, matches, counted } = skillAverage(playerId, analyses, 'x01');
  if (avg === null) return { handicap: baseStartScore, matches, counted };

  const scaled = baseStartScore * Math.min(1, avg / HANDICAP_REFERENCE_AVG);
  const handicap = clampInt(
    roundToStep(scaled, 25),
    baseStartScore * 0.4,
    baseStartScore,
  );
  return { handicap, matches, counted };
}

/**
 * Gotcha's handicap is a starting head start in the same shared score space
 * the knockback mechanic already uses.
 */
export function computeGotchaHandicap(playerId: string, analyses: MatchAnalysis[], target: number): ModeHandicap {
  const { avg, matches, counted } = skillAverage(playerId, analyses, 'gotcha');
  if (avg === null) return { handicap: 0, matches, counted };

  const headStart = target * (1 - Math.min(1, avg / HANDICAP_REFERENCE_AVG));
  const handicap = clampInt(headStart, 0, target - 1);
  return { handicap, matches, counted };
}

/** Killer's handicap is extra starting lives for a weaker player. */
export function computeKillerHandicap(playerId: string, analyses: MatchAnalysis[], baseLives: number): ModeHandicap {
  const { avg, matches, counted } = skillAverage(playerId, analyses, 'killer');
  if (avg === null) return { handicap: baseLives, matches, counted };

  const lives = baseLives * Math.max(1, HANDICAP_REFERENCE_AVG / Math.max(avg, MIN_AVG_FLOOR));
  const handicap = clampInt(lives, baseLives, 9);
  return { handicap, matches, counted };
}
