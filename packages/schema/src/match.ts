import { z } from 'zod';
import { DartThrowSchema, SegmentSchema } from './events.ts';

export const PlayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().default('#4f8ef7'),
});
export type Player = z.infer<typeof PlayerSchema>;

/** Rule governing how a leg must be started or finished. */
export const InOutModeSchema = z.enum(['straight', 'double', 'master']);
export type InOutMode = z.infer<typeof InOutModeSchema>;

// ---------------------------------------------------------------------------
// Game configs
// ---------------------------------------------------------------------------

/**
 * Per-player overrides are the handicap mechanism: one player can play 501
 * double-out while another plays 301 straight-out in the same leg.
 */
export const X01PlayerOverridesSchema = z.object({
  startScore: z.number().int().positive().optional(),
  inMode: InOutModeSchema.optional(),
  outMode: InOutModeSchema.optional(),
});
export type X01PlayerOverrides = z.infer<typeof X01PlayerOverridesSchema>;

export const X01ConfigSchema = z.object({
  gameType: z.literal('x01'),
  startScore: z.number().int().positive().default(501),
  inMode: InOutModeSchema.default('straight'),
  outMode: InOutModeSchema.default('double'),
  legsToWin: z.number().int().positive().default(3),
  setsToWin: z.number().int().positive().default(1),
  /**
   * When the leg stops.
   *
   * `first`       -- the leg ends the moment someone checks out.
   * `all-but-one` -- play continues until only one player is left unfinished,
   *                  so everyone gets a finishing place. The leg is still won
   *                  by whoever checked out first. With two players the two
   *                  settings are equivalent.
   */
  legEnd: z.enum(['first', 'all-but-one']).default('first'),
  perPlayer: z.record(z.string(), X01PlayerOverridesSchema).default({}),
});
export type X01Config = z.infer<typeof X01ConfigSchema>;

export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25] as const;

export const CricketConfigSchema = z.object({
  gameType: z.literal('cricket'),
  /** `cutthroat` gives points to opponents; lowest score wins. */
  variant: z.enum(['standard', 'cutthroat']).default('standard'),
  targets: z.array(z.number().int()).default([...CRICKET_TARGETS]),
  /** When false, closing is all that matters and points are not tracked. */
  scoring: z.boolean().default(true),
  legsToWin: z.number().int().positive().default(1),
  setsToWin: z.number().int().positive().default(1),
});
export type CricketConfig = z.infer<typeof CricketConfigSchema>;

export const GotchaConfigSchema = z.object({
  gameType: z.literal('gotcha'),
  target: z.number().int().positive().default(301),
  /** Where a knocked-back player is sent. */
  knockback: z.enum(['zero', 'previousTurn']).default('zero'),
  /** Overshooting the target busts the turn and requires an exact finish. */
  exactFinish: z.boolean().default(true),
  legsToWin: z.number().int().positive().default(1),
  setsToWin: z.number().int().positive().default(1),
});
export type GotchaConfig = z.infer<typeof GotchaConfigSchema>;

/** Every hole is nominally this many strokes before handicap. */
export const GOLF_PAR = 4;
export const GOLF_HOLES = 18;
/**
 * The handicap a player starts on, and the points a player scores by playing
 * every hole to their personal par (18 holes x 2 points). Scoring 36 therefore
 * means "played exactly to handicap", which is what keeps it stable.
 */
export const GOLF_BASE_HANDICAP = 36;

export const GolfConfigSchema = z.object({
  gameType: z.literal('golf'),
  /** Holes are numbered 1..holes and each hole targets its own number. */
  holes: z.number().int().min(1).max(18).default(GOLF_HOLES),
  par: z.number().int().min(1).max(9).default(GOLF_PAR),
  /**
   * Stableford handicap in points, per player. A missing entry means the
   * newcomer's 36. The server fills this in from match history at start time,
   * but it is stored in the config so the match stays reproducible from its own
   * record -- recomputing the handicap later must not rewrite a played round.
   */
  handicaps: z.record(z.string(), z.number().int().min(0).max(72)).default({}),
  legsToWin: z.number().int().positive().default(1),
  setsToWin: z.number().int().positive().default(1),
});
export type GolfConfig = z.infer<typeof GolfConfigSchema>;

export const GameConfigSchema = z.discriminatedUnion('gameType', [
  X01ConfigSchema,
  CricketConfigSchema,
  GotchaConfigSchema,
  GolfConfigSchema,
]);
export type GameConfig = z.infer<typeof GameConfigSchema>;
export type GameType = GameConfig['gameType'];

// ---------------------------------------------------------------------------
// Commands -- the append-only log that is the source of truth
// ---------------------------------------------------------------------------

export const MatchCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('START') }),
  z.object({ type: z.literal('THROW'), throw: DartThrowSchema }),
  /** Remove the most recent dart. Detection misreads happen; undo is first-class. */
  z.object({ type: z.literal('UNDO') }),
  /**
   * Replace the segment of an already-recorded dart, addressed by its stable
   * throw id. Addressing by id rather than by position in the current turn is
   * deliberate: the most valuable correction is undoing a wrongly-detected
   * dart that already busted the turn and handed over, at which point the dart
   * is no longer part of any current turn.
   */
  z.object({
    type: z.literal('CORRECT_THROW'),
    throwId: z.string(),
    segment: SegmentSchema,
  }),
  /** End the current turn early (e.g. player threw fewer than three darts). */
  z.object({ type: z.literal('NEXT_PLAYER') }),
  /**
   * Stop the match where it stands and award it to whoever is closest to
   * winning. Each engine decides what "closest" means for its own game, because
   * only the engine knows whether a low score is good.
   */
  z.object({ type: z.literal('END_MATCH') }),
  z.object({ type: z.literal('RESTART_LEG') }),
  /**
   * Roster changes mid-match. These are ordinary log commands, so the join or
   * departure replays correctly on every refold and undo.
   */
  z.object({ type: z.literal('ADD_PLAYER'), player: PlayerSchema }),
  z.object({ type: z.literal('REMOVE_PLAYER'), playerId: z.string() }),
]);
export type MatchCommand = z.infer<typeof MatchCommandSchema>;

// ---------------------------------------------------------------------------
// Domain events -- what the engine emits, consumed by stats and achievements
// ---------------------------------------------------------------------------

export type DomainEvent =
  | { type: 'match.started' }
  | { type: 'player.joined'; playerId: string; name: string }
  | { type: 'player.left'; playerId: string }
  | { type: 'throw.recorded'; playerId: string; dartIndex: number; value: number }
  | { type: 'turn.completed'; playerId: string; total: number; darts: number; busted: boolean }
  | { type: 'player.busted'; playerId: string; reason: string }
  | { type: 'leg.won'; playerId: string; darts: number }
  | { type: 'set.won'; playerId: string }
  | { type: 'match.won'; playerId: string }
  | { type: 'x01.checkout'; playerId: string; score: number; darts: number }
  | { type: 'x01.placed'; playerId: string; place: number }
  | { type: 'cricket.closed'; playerId: string; target: number }
  | { type: 'cricket.points'; playerId: string; target: number; points: number }
  | { type: 'gotcha.knockback'; byPlayerId: string; victimPlayerId: string; from: number; to: number }
  | {
      type: 'golf.hole';
      playerId: string;
      hole: number;
      /** Darts used on the hole. */
      strokes: number;
      /** This player's par for the hole, after their handicap strokes. */
      par: number;
      points: number;
      /** False when the hole was abandoned at par + 1 without a hit. */
      holed: boolean;
    }
  /** The match was stopped early and awarded to whoever led. */
  | { type: 'match.conceded'; playerId: string };

// ---------------------------------------------------------------------------
// View -- the only thing the frontend renders. Server-authoritative.
// ---------------------------------------------------------------------------

export interface PlayerView {
  playerId: string;
  name: string;
  color: string;
  /** Primary large number: remaining for X01, points for Cricket/Gotcha. */
  score: number;
  isActive: boolean;
  legsWon: number;
  setsWon: number;
  /** Suggested checkout route, X01 only. */
  checkout: string[] | null;
  /** Game-specific extras, e.g. Cricket marks per target. */
  detail: Record<string, unknown>;
  /** Live match statistics, recomputed each turn. */
  stats: {
    average3: number | null;
    dartsThrown: number;
    /** Cricket marks per round. */
    mpr?: number | null;
  };
}

export interface TurnView {
  throws: Array<{ id: string; label: string; value: number }>;
  total: number;
  dartsRemaining: number;
  /**
   * The checkout route for the rest of this turn, one label per dart.
   *
   * Empty unless the score is actually checkable with the darts remaining --
   * advice on a score you cannot finish from is noise, not help.
   */
  hints: string[];
}

/** A recently thrown dart, offered to the UI so misdetections can be corrected. */
export interface RecentThrow {
  id: string;
  label: string;
  value: number;
  playerId: string;
}

export interface MatchView {
  matchId: string;
  gameType: GameType;
  status: 'idle' | 'playing' | 'finished';
  players: PlayerView[];
  activePlayerId: string | null;
  turn: TurnView;
  leg: number;
  set: number;
  winnerId: string | null;
  /** Most recent darts across turn boundaries, newest last. Populated by Match. */
  recent: RecentThrow[];
}
