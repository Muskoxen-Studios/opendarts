import type {
  DartThrow,
  DomainEvent,
  GameConfig,
  GameType,
  MatchCommand,
  MatchView,
  Player,
} from '@darts/schema';

/**
 * Commands an engine must handle.
 *
 * Note the absence of UNDO and CORRECT_THROW. Those are handled by the Match
 * wrapper (match.ts), which edits the command log and re-folds it from the
 * start of the leg. Engines therefore only ever move forward, which keeps every
 * engine dramatically simpler and makes undo correct by construction rather
 * than by careful bookkeeping in each game.
 */
export type ForwardCommand = Extract<
  MatchCommand,
  {
    type:
      | 'START'
      | 'THROW'
      | 'NEXT_PLAYER'
      | 'RESTART_LEG'
      | 'ADD_PLAYER'
      | 'REMOVE_PLAYER'
      | 'END_MATCH';
  }
>;

export interface EngineResult<S> {
  state: S;
  events: DomainEvent[];
}

export interface GameEngine<Cfg extends GameConfig, S> {
  readonly id: GameType;
  /** Fill in defaults and validate a raw config object. */
  parseConfig(raw: unknown): Cfg;
  createInitialState(players: Player[], cfg: Cfg): S;
  reduce(state: S, cmd: ForwardCommand, cfg: Cfg): EngineResult<S>;
  view(state: S, cfg: Cfg, matchId: string): MatchView;
}

/** State common to every game: turn rotation, legs, sets. */
export interface BaseState {
  players: Player[];
  activeIndex: number;
  status: 'idle' | 'playing' | 'finished';
  leg: number;
  set: number;
  legsWon: Record<string, number>;
  setsWon: Record<string, number>;
  /** Darts thrown in the current turn (max 3). */
  turn: DartThrow[];
  winnerId: string | null;
  /** Darts thrown in the current leg, per player. */
  legDarts: Record<string, number>;
  /** Which player starts the current leg, rotated each leg. */
  legStartIndex: number;
}

export type { DartThrow, DomainEvent, MatchView, Player };
