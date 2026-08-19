import type { MatchAnalysis } from '../analysis.ts';
import type { CareerStats } from '../career.ts';

export interface AchievementContext {
  playerId: string;
  /** The match that just finished. */
  match: MatchAnalysis;
  /** Career statistics INCLUDING the match above. */
  career: CareerStats;
}

export interface AchievementResult {
  unlocked: boolean;
  /** Current progress toward `goal`, for the UI's progress bar. */
  progress?: number;
  goal?: number;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier?: 'bronze' | 'silver' | 'gold';
  /**
   * Target for progress-tracked achievements, known without evaluating.
   *
   * `evaluate` also reports a goal, but only once there is something to
   * evaluate against -- a player who has never thrown a dart would otherwise
   * see every progress bar as "0 / 1".
   */
  goal?: number;
  /**
   * Set when the achievement needs dart coordinates.
   *
   * Coordinates are reported by the board but their units and origin are not
   * yet established, so these stay disabled. Because achievements are evaluated
   * over the stored command log rather than live, enabling them later unlocks
   * them retroactively across all history -- no data is lost by waiting.
   */
  requiresCoords?: boolean;
  evaluate(ctx: AchievementContext): AchievementResult;
}

export interface UnlockedAchievement {
  achievementId: string;
  unlockedAt: string | null;
  progress: number;
  goal: number;
}
