import type { MatchAnalysis } from '../analysis.ts';
import { computeCareer, type CareerStats } from '../career.ts';
import { CATALOGUE } from './catalogue.ts';
import type { Achievement, UnlockedAchievement } from './types.ts';

export interface EvaluateOptions {
  catalogue?: Achievement[];
  /**
   * Enable achievements that need dart coordinates. Off until the board's
   * throw payload is understood; see recon/FINDINGS.md.
   */
  coordsEnabled?: boolean;
}

function active(opts: EvaluateOptions): Achievement[] {
  const list = opts.catalogue ?? CATALOGUE;
  return opts.coordsEnabled ? list : list.filter((a) => !a.requiresCoords);
}

/** Evaluate the catalogue against a single finished match. */
export function evaluateMatch(
  playerId: string,
  match: MatchAnalysis,
  career: CareerStats,
  opts: EvaluateOptions = {},
): Map<string, UnlockedAchievement> {
  const out = new Map<string, UnlockedAchievement>();
  for (const a of active(opts)) {
    const r = a.evaluate({ playerId, match, career });
    out.set(a.id, {
      achievementId: a.id,
      unlockedAt: r.unlocked ? (match.endedAt ?? new Date().toISOString()) : null,
      progress: r.progress ?? (r.unlocked ? 1 : 0),
      goal: r.goal ?? 1,
    });
  }
  return out;
}

/**
 * Re-evaluate the whole catalogue across a player's full history.
 *
 * This is what makes newly added achievements fair: they unlock against past
 * play rather than starting from zero. Analyses must be in chronological order,
 * and an achievement keeps the timestamp of the first match that satisfied it.
 *
 * Career stats are recomputed for each prefix, which is quadratic in the number
 * of matches. That is fine for a backfill over a household's match history; if
 * it ever becomes slow, computeCareer can be made incremental without changing
 * this function's contract.
 */
export function backfillPlayer(
  playerId: string,
  analyses: MatchAnalysis[],
  opts: EvaluateOptions = {},
): UnlockedAchievement[] {
  const result = new Map<string, UnlockedAchievement>();
  const mine = analyses.filter((a) => a.players.some((p) => p.id === playerId));

  for (let i = 0; i < mine.length; i++) {
    const prefix = mine.slice(0, i + 1);
    const career = computeCareer(playerId, prefix);
    const match = mine[i];
    if (!match) continue;

    for (const [id, entry] of evaluateMatch(playerId, match, career, opts)) {
      const existing = result.get(id);
      if (!existing) {
        result.set(id, entry);
        continue;
      }
      // Keep the earliest unlock, but always take the latest progress.
      result.set(id, {
        achievementId: id,
        unlockedAt: existing.unlockedAt ?? entry.unlockedAt,
        progress: Math.max(existing.progress, entry.progress),
        goal: entry.goal,
      });
    }
  }

  return [...result.values()];
}
