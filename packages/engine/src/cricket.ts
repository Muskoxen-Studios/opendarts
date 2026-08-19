import {
  CricketConfigSchema,
  segmentLabel,
  segmentMarks,
  type CricketConfig,
  type DomainEvent,
  type MatchView,
  type Player,
  type PlayerView,
} from '@darts/schema';
import {
  activePlayer,
  addPlayerToBase,
  advanceTurn,
  awardLeg,
  clone,
  createBaseState,
  endMatchEarly,
  removePlayerFromBase,
  turnIsComplete,
} from './base.ts';
import type { BaseState, EngineResult, ForwardCommand, GameEngine } from './types.ts';

export const MARKS_TO_CLOSE = 3;

export interface CricketState {
  base: BaseState;
  /** playerId -> target -> marks (0..3). */
  marks: Record<string, Record<number, number>>;
  scores: Record<string, number>;
  /** Marks earned this leg, per player. */
  legMarks: Record<string, number>;
  /**
   * Marks-per-round is deliberately computed over COMPLETED rounds only.
   *
   * Dividing running marks by a fractional round count makes the figure jump
   * around mid-turn -- a treble on the first dart of a turn reads as 9.00 MPR,
   * which is meaningless. Accumulating whole turns keeps it stable and matches
   * how the number is quoted in practice.
   */
  turnMarks: Record<string, number>;
  completedMarks: Record<string, number>;
  completedRounds: Record<string, number>;
}

/** Points a single mark on this target is worth. */
export function targetPoints(target: number): number {
  return target === 25 ? 25 : target;
}

function isClosedBy(state: CricketState, playerId: string, target: number): boolean {
  return (state.marks[playerId]?.[target] ?? 0) >= MARKS_TO_CLOSE;
}

/** True when every player has closed the target, so it scores for nobody. */
function closedByAll(state: CricketState, target: number): boolean {
  return state.base.players.every((p) => isClosedBy(state, p.id, target));
}

function hasClosedEverything(state: CricketState, playerId: string, cfg: CricketConfig): boolean {
  return cfg.targets.every((t) => isClosedBy(state, playerId, t));
}

/**
 * Cricket is won by closing every target while holding the winning score.
 * In standard play the highest score wins, in cut-throat the lowest.
 */
function hasWinningScore(state: CricketState, playerId: string, cfg: CricketConfig): boolean {
  if (!cfg.scoring) return true;
  const mine = state.scores[playerId] ?? 0;
  const others = state.base.players
    .filter((p) => p.id !== playerId)
    .map((p) => state.scores[p.id] ?? 0);
  if (others.length === 0) return true;
  return cfg.variant === 'cutthroat'
    ? mine <= Math.min(...others)
    : mine >= Math.max(...others);
}

function resetLeg(state: CricketState, cfg: CricketConfig): void {
  for (const p of state.base.players) {
    const row: Record<number, number> = {};
    for (const t of cfg.targets) row[t] = 0;
    state.marks[p.id] = row;
    state.scores[p.id] = 0;
    state.legMarks[p.id] = 0;
    state.turnMarks[p.id] = 0;
    state.completedMarks[p.id] = 0;
    state.completedRounds[p.id] = 0;
  }
}

/** Roll the in-progress turn's marks into the completed-round totals. */
function closeRound(state: CricketState, playerId: string): void {
  state.completedMarks[playerId] = (state.completedMarks[playerId] ?? 0) + (state.turnMarks[playerId] ?? 0);
  state.completedRounds[playerId] = (state.completedRounds[playerId] ?? 0) + 1;
  state.turnMarks[playerId] = 0;
}

export const cricketEngine: GameEngine<CricketConfig, CricketState> = {
  id: 'cricket',

  parseConfig(raw) {
    return CricketConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: CricketConfig): CricketState {
    const state: CricketState = {
      base: createBaseState(players),
      marks: {},
      scores: {},
      legMarks: {},
      turnMarks: {},
      completedMarks: {},
      completedRounds: {},
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<CricketState> {
    const state = clone(prev);
    const events: DomainEvent[] = [];
    const base = state.base;

    switch (cmd.type) {
      case 'START': {
        if (base.status !== 'idle') return { state: prev, events: [] };
        base.status = 'playing';
        events.push({ type: 'match.started' });
        return { state, events };
      }

      case 'NEXT_PLAYER': {
        if (base.status !== 'playing') return { state: prev, events: [] };
        const p = activePlayer(base);
        events.push({
          type: 'turn.completed',
          playerId: p.id,
          total: 0,
          darts: base.turn.length,
          busted: false,
        });
        closeRound(state, p.id);
        advanceTurn(base);
        return { state, events };
      }

      case 'ADD_PLAYER': {
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events: [] };
        const row: Record<number, number> = {};
        for (const t of cfg.targets) row[t] = 0;
        state.marks[cmd.player.id] = row;
        state.scores[cmd.player.id] = 0;
        state.legMarks[cmd.player.id] = 0;
        state.turnMarks[cmd.player.id] = 0;
        state.completedMarks[cmd.player.id] = 0;
        state.completedRounds[cmd.player.id] = 0;
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.marks[cmd.playerId];
        delete state.scores[cmd.playerId];
        delete state.legMarks[cmd.playerId];
        delete state.turnMarks[cmd.playerId];
        delete state.completedMarks[cmd.playerId];
        delete state.completedRounds[cmd.playerId];
        events.push({ type: 'player.left', playerId: cmd.playerId });
        return { state, events };
      }

      case 'END_MATCH': {
        // Marks closed dominate: the game is won by closing everything, and
        // points only decide between players who are level on closures. In
        // cut-throat a low score is the good one, so the sign flips.
        events.push(
          ...endMatchEarly(base, (id) => {
            const row = state.marks[id] ?? {};
            const closed = cfg.targets.reduce(
              (sum, t) => sum + Math.min(row[t] ?? 0, MARKS_TO_CLOSE),
              0,
            );
            const points = state.scores[id] ?? 0;
            return closed * 1000 + (cfg.variant === 'cutthroat' ? -points : points);
          }),
        );
        return { state, events };
      }

      case 'RESTART_LEG': {
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetLeg(state, cfg);
        return { state, events };
      }

      case 'THROW': {
        if (base.status !== 'playing') return { state: prev, events: [] };

        const player = activePlayer(base);
        const dart = cmd.throw;
        base.turn.push(dart);
        base.legDarts[player.id] = (base.legDarts[player.id] ?? 0) + 1;

        const target = dart.segment.number;
        const onTarget = cfg.targets.includes(target) && dart.segment.ring !== 'MISS';
        let pointsScored = 0;

        if (onTarget) {
          const earned = segmentMarks(dart.segment);
          state.legMarks[player.id] = (state.legMarks[player.id] ?? 0) + earned;
          state.turnMarks[player.id] = (state.turnMarks[player.id] ?? 0) + earned;

          const row = state.marks[player.id] ?? {};
          const current = row[target] ?? 0;
          const used = Math.min(earned, MARKS_TO_CLOSE - current);
          const overflow = earned - used;
          row[target] = current + used;
          state.marks[player.id] = row;

          if (current < MARKS_TO_CLOSE && row[target] === MARKS_TO_CLOSE) {
            events.push({ type: 'cricket.closed', playerId: player.id, target });
          }

          // Overflow marks score, but only while an opponent has it open.
          if (overflow > 0 && cfg.scoring && !closedByAll(state, target)) {
            pointsScored = overflow * targetPoints(target);
            if (cfg.variant === 'cutthroat') {
              // Points are handed to every opponent who has not closed it.
              for (const opp of base.players) {
                if (opp.id === player.id) continue;
                if (isClosedBy(state, opp.id, target)) continue;
                state.scores[opp.id] = (state.scores[opp.id] ?? 0) + pointsScored;
                events.push({
                  type: 'cricket.points',
                  playerId: opp.id,
                  target,
                  points: pointsScored,
                });
              }
            } else {
              state.scores[player.id] = (state.scores[player.id] ?? 0) + pointsScored;
              events.push({
                type: 'cricket.points',
                playerId: player.id,
                target,
                points: pointsScored,
              });
            }
          }
        }

        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value: pointsScored,
        });

        if (hasClosedEverything(state, player.id, cfg) && hasWinningScore(state, player.id, cfg)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: 0,
            darts: base.turn.length,
            busted: false,
          });
          closeRound(state, player.id);
          events.push(
            ...awardLeg(base, player.id, cfg.legsToWin, cfg.setsToWin, () => {
              resetLeg(state, cfg);
            }),
          );
          return { state, events };
        }

        if (turnIsComplete(base)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: 0,
            darts: base.turn.length,
            busted: false,
          });
          closeRound(state, player.id);
          advanceTurn(base);
        }

        return { state, events };
      }
    }
  },

  view(state, cfg, matchId): MatchView {
    const base = state.base;
    const active = base.players[base.activeIndex];

    const players: PlayerView[] = base.players.map((p, i) => {
      const darts = base.legDarts[p.id] ?? 0;
      const rounds = state.completedRounds[p.id] ?? 0;
      const marks = state.completedMarks[p.id] ?? 0;
      return {
        playerId: p.id,
        name: p.name,
        color: p.color,
        score: state.scores[p.id] ?? 0,
        isActive: i === base.activeIndex && base.status === 'playing',
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: null,
        detail: {
          marks: state.marks[p.id] ?? {},
          targets: cfg.targets,
          variant: cfg.variant,
          legMarks: state.legMarks[p.id] ?? 0,
        },
        stats: {
          average3: null,
          dartsThrown: darts,
          mpr: rounds > 0 ? marks / rounds : null,
        },
      };
    });

    return {
      matchId,
      gameType: 'cricket',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value })),
        total: base.turn.reduce((a, t) => a + t.value, 0),
        dartsRemaining: 3 - base.turn.length,
        hints: [],
      },
      leg: base.leg,
      set: base.set,
      winnerId: base.winnerId,
      // Filled in by Match, which owns the command log.
      recent: [],
    };
  },
};
