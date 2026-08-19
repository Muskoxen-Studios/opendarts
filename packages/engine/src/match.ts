import {
  GameConfigSchema,
  segmentLabel,
  segmentValue,
  type DartThrow,
  type DomainEvent,
  type GameConfig,
  type MatchCommand,
  type MatchView,
  type Player,
  type RecentThrow,
} from '@darts/schema';
import { engineFor, type AnyEngine } from './registry.ts';
import type { ForwardCommand } from './types.ts';

function isForward(cmd: MatchCommand): cmd is ForwardCommand {
  return cmd.type !== 'UNDO' && cmd.type !== 'CORRECT_THROW';
}

/**
 * A match is a fold over an append-only command log.
 *
 * UNDO and CORRECT_THROW are not engine concerns: they edit the log and replay
 * it from the beginning. That makes undo correct by construction for every
 * game -- including ones added later -- instead of requiring each engine to
 * carefully unwind its own state. It also means the log is a complete record,
 * which is what lets statistics and achievements be recomputed or backfilled.
 */
export class Match {
  readonly matchId: string;
  readonly players: Player[];
  readonly config: GameConfig;

  private engine: AnyEngine;
  private commands: MatchCommand[];
  private state: unknown;
  private events: DomainEvent[];

  constructor(matchId: string, players: Player[], rawConfig: unknown) {
    this.matchId = matchId;
    this.players = players;
    const parsed = GameConfigSchema.parse(rawConfig);
    this.engine = engineFor(parsed.gameType);
    this.config = this.engine.parseConfig(parsed) as GameConfig;
    this.commands = [];
    this.state = this.engine.createInitialState(players, this.config);
    this.events = [];
  }

  /** Rebuild a match from its persisted command log. */
  static fromLog(
    matchId: string,
    players: Player[],
    rawConfig: unknown,
    commands: MatchCommand[],
  ): Match {
    const match = new Match(matchId, players, rawConfig);
    match.commands = [...commands];
    match.refold();
    return match;
  }

  get view(): MatchView {
    const view = this.engine.view(this.state, this.config, this.matchId);
    view.recent = this.recentThrows();
    return view;
  }

  /**
   * The last `limit` darts thrown, newest last, each with the player who threw
   * it. Lets the UI correct a dart that has already left the current turn --
   * notably one that caused a bust and an unwanted handover.
   *
   * Every THROW command produces exactly one `throw.recorded` event, so the
   * two sequences line up index for index.
   */
  recentThrows(limit = 6): RecentThrow[] {
    const throwCommands = this.commands.filter((c) => c.type === 'THROW');
    const recorded = this.events.filter((e) => e.type === 'throw.recorded');
    const out: RecentThrow[] = [];
    const start = Math.max(0, throwCommands.length - limit);
    for (let i = start; i < throwCommands.length; i++) {
      const cmd = throwCommands[i];
      if (!cmd || cmd.type !== 'THROW') continue;
      const ev = recorded[i];
      out.push({
        id: cmd.throw.id,
        label: segmentLabel(cmd.throw.segment),
        value: cmd.throw.value,
        playerId: ev && ev.type === 'throw.recorded' ? ev.playerId : '',
      });
    }
    return out;
  }

  /** The full command log. This is the source of truth. */
  get log(): readonly MatchCommand[] {
    return this.commands;
  }

  /** Every domain event produced by the current log, in order. */
  get allEvents(): readonly DomainEvent[] {
    return this.events;
  }

  get finished(): boolean {
    return this.view.status === 'finished';
  }

  /**
   * Apply a command. Returns only the events newly produced, so callers can
   * react to them (toasts, achievement checks) without re-processing history.
   */
  apply(cmd: MatchCommand): DomainEvent[] {
    const before = this.events.length;

    if (cmd.type === 'UNDO') {
      const idx = this.lastThrowIndex();
      if (idx < 0) return [];
      this.commands.splice(idx, 1);
      this.refold();
      return [];
    }

    if (cmd.type === 'CORRECT_THROW') {
      const idx = this.commands.findIndex(
        (c) => c.type === 'THROW' && c.throw.id === cmd.throwId,
      );
      if (idx < 0) return [];
      const target = this.commands[idx];
      if (!target || target.type !== 'THROW') return [];
      this.commands[idx] = {
        type: 'THROW',
        throw: {
          ...target.throw,
          segment: cmd.segment,
          value: segmentValue(cmd.segment),
        },
      };
      this.refold();
      return [];
    }

    const normalized = this.normalize(cmd);
    this.commands.push(normalized);
    const result = this.engine.reduce(this.state, normalized, this.config);
    this.state = result.state;
    this.events = [...this.events, ...result.events];
    return this.events.slice(before);
  }

  /**
   * Recompute value from segment rather than trusting the wire. A bridge bug or
   * a mismatched adapter must not be able to inject a wrong score.
   */
  private normalize(cmd: ForwardCommand): ForwardCommand {
    if (cmd.type !== 'THROW') return cmd;
    const value = segmentValue(cmd.throw.segment);
    if (value === cmd.throw.value) return cmd;
    const fixed: DartThrow = { ...cmd.throw, value };
    return { type: 'THROW', throw: fixed };
  }

  private lastThrowIndex(): number {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      if (this.commands[i]?.type === 'THROW') return i;
    }
    return -1;
  }

  private refold(): void {
    this.state = this.engine.createInitialState(this.players, this.config);
    const events: DomainEvent[] = [];
    for (const cmd of this.commands) {
      if (!isForward(cmd)) continue;
      const result = this.engine.reduce(this.state, cmd, this.config);
      this.state = result.state;
      events.push(...result.events);
    }
    this.events = events;
  }
}
