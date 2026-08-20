import {
  ShanghaiConfigSchema,
  segmentLabel,
  type DomainEvent,
  type MatchView,
  type Player,
  type PlayerView,
  type ShanghaiConfig,
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

/**
 * Shanghai.
 *
 * Rounds run from `startRound` to `endRound`, each round's number the shared
 * target -- everyone plays the same round before it advances. Only darts on the
 * round's own number score, at their ring value. Landing a single, a double and
 * a triple of that number in the same turn -- "a Shanghai" -- wins outright.
 * Otherwise the round with the highest total wins.
 */

export interface ShanghaiState {
  base: BaseState;
  /** The number every dart is currently aimed at. */
  round: number;
  scores: Record<string, number>;
  turnStartScore: Record<string, number>;
  /** Points scored per round played, in order, for the scoreboard's card. */
  results: Record<string, number[]>;
  /** Which rings of the round's number have been hit this turn, for the Shanghai check. */
  turnHits: { single: boolean; double: boolean; triple: boolean };
  /** Players who have already taken their turn in the current round. */
  thrownThisRound: string[];
}

function beginTurn(state: ShanghaiState): void {
  const p = state.base.players[state.base.activeIndex];
  if (!p) return;
  state.turnStartScore[p.id] = state.scores[p.id] ?? 0;
  state.turnHits = { single: false, double: false, triple: false };
}

function seatPlayer(state: ShanghaiState, playerId: string): void {
  state.scores[playerId] = 0;
  state.turnStartScore[playerId] = 0;
  state.results[playerId] = [];
}

function resetLeg(state: ShanghaiState, cfg: ShanghaiConfig): void {
  state.round = cfg.startRound;
  state.thrownThisRound = [];
  for (const p of state.base.players) seatPlayer(state, p.id);
}

/**
 * Advance past the current round once everyone in it has thrown, awarding the
 * match if that was the last one. Returns true when the match ended.
 */
function completeRoundIfDone(
  state: ShanghaiState,
  cfg: ShanghaiConfig,
  base: BaseState,
  events: DomainEvent[],
): boolean {
  if (state.thrownThisRound.length < base.players.length) return false;

  events.push({ type: 'shanghai.round', round: state.round });
  state.thrownThisRound = [];
  state.round += 1;

  if (state.round > cfg.endRound) {
    const winner = [...base.players].sort(
      (a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0),
    )[0];
    events.push(
      ...awardLeg(base, winner?.id ?? base.players[0]!.id, cfg.legsToWin, cfg.setsToWin, () => {
        resetLeg(state, cfg);
        beginTurn(state);
      }),
    );
    return true;
  }
  return false;
}

export const shanghaiEngine: GameEngine<ShanghaiConfig, ShanghaiState> = {
  id: 'shanghai',

  parseConfig(raw) {
    return ShanghaiConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: ShanghaiConfig): ShanghaiState {
    const state: ShanghaiState = {
      base: createBaseState(players),
      round: cfg.startRound,
      scores: {},
      turnStartScore: {},
      results: {},
      turnHits: { single: false, double: false, triple: false },
      thrownThisRound: [],
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<ShanghaiState> {
    const state = clone(prev);
    const events: DomainEvent[] = [];
    const base = state.base;

    switch (cmd.type) {
      case 'START': {
        if (base.status !== 'idle') return { state: prev, events: [] };
        base.status = 'playing';
        beginTurn(state);
        events.push({ type: 'match.started' });
        return { state, events };
      }

      case 'NEXT_PLAYER': {
        if (base.status !== 'playing') return { state: prev, events: [] };
        if (base.turnEnded) {
          advanceTurn(base);
          beginTurn(state);
          return { state, events };
        }
        const p = activePlayer(base);
        events.push({
          type: 'turn.completed',
          playerId: p.id,
          total: (state.scores[p.id] ?? 0) - (state.turnStartScore[p.id] ?? 0),
          darts: base.turn.length,
          busted: false,
        });
        (state.results[p.id] ??= []).push(
          (state.scores[p.id] ?? 0) - (state.turnStartScore[p.id] ?? 0),
        );
        if (!state.thrownThisRound.includes(p.id)) state.thrownThisRound.push(p.id);
        const ended = completeRoundIfDone(state, cfg, base, events);
        if (!ended) {
          advanceTurn(base);
          beginTurn(state);
        }
        return { state, events };
      }

      case 'ADVANCE_TURN': {
        if (!base.turnEnded) return { state: prev, events: [] };
        advanceTurn(base);
        beginTurn(state);
        return { state, events };
      }

      case 'ADD_PLAYER': {
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events: [] };
        seatPlayer(state, cmd.player.id);
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.scores[cmd.playerId];
        delete state.turnStartScore[cmd.playerId];
        delete state.results[cmd.playerId];
        state.thrownThisRound = state.thrownThisRound.filter((id) => id !== cmd.playerId);
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (base.players.length > 0 && base.status === 'playing') beginTurn(state);
        return { state, events };
      }

      case 'END_MATCH': {
        events.push(...endMatchEarly(base, (id) => state.scores[id] ?? 0));
        return { state, events };
      }

      case 'RESTART_LEG': {
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetLeg(state, cfg);
        beginTurn(state);
        return { state, events };
      }

      case 'THROW': {
        if (base.status !== 'playing' || base.turnEnded) return { state: prev, events: [] };

        const player = activePlayer(base);
        const dart = cmd.throw;
        base.turn.push(dart);
        base.legDarts[player.id] = (base.legDarts[player.id] ?? 0) + 1;

        const onTarget = dart.segment.ring !== 'MISS' && dart.segment.number === state.round;
        let scored = 0;
        if (onTarget) {
          scored = dart.value;
          state.scores[player.id] = (state.scores[player.id] ?? 0) + scored;
          if (dart.segment.ring === 'SINGLE_INNER' || dart.segment.ring === 'SINGLE_OUTER') {
            state.turnHits.single = true;
          }
          if (dart.segment.ring === 'DOUBLE') state.turnHits.double = true;
          if (dart.segment.ring === 'TRIPLE') state.turnHits.triple = true;
        }

        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value: scored,
        });

        const shanghai =
          cfg.instantWin && state.turnHits.single && state.turnHits.double && state.turnHits.triple;

        if (shanghai) {
          events.push({ type: 'shanghai.win', playerId: player.id, round: state.round });
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
            darts: base.turn.length,
            busted: false,
          });
          (state.results[player.id] ??= []).push(
            (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
          );
          events.push(
            ...awardLeg(base, player.id, cfg.legsToWin, cfg.setsToWin, () => {
              resetLeg(state, cfg);
              beginTurn(state);
            }),
          );
          return { state, events };
        }

        if (turnIsComplete(base)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
            darts: base.turn.length,
            busted: false,
          });
          (state.results[player.id] ??= []).push(
            (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
          );
          if (!state.thrownThisRound.includes(player.id)) state.thrownThisRound.push(player.id);
          const ended = completeRoundIfDone(state, cfg, base, events);
          if (!ended) base.turnEnded = true;
        }

        return { state, events };
      }
    }
  },

  view(state, cfg, matchId): MatchView {
    const base = state.base;
    const active = base.players[base.activeIndex];
    const dartsLeft = 3 - base.turn.length;

    const players: PlayerView[] = base.players.map((p, i) => {
      const darts = base.legDarts[p.id] ?? 0;
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
          round: state.round,
          startRound: cfg.startRound,
          endRound: cfg.endRound,
          results: state.results[p.id] ?? [],
        },
        stats: {
          average3: darts > 0 ? ((state.scores[p.id] ?? 0) / darts) * 3 : null,
          dartsThrown: darts,
        },
      };
    });

    const hints =
      active && base.status === 'playing'
        ? Array.from({ length: Math.max(0, dartsLeft) }, () => String(state.round))
        : [];

    return {
      matchId,
      gameType: 'shanghai',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value, coords: t.coords })),
        total: active
          ? (state.scores[active.id] ?? 0) - (state.turnStartScore[active.id] ?? 0)
          : 0,
        dartsRemaining: dartsLeft,
        hints,
      },
      leg: base.leg,
      set: base.set,
      winnerId: base.winnerId,
      recent: [],
    };
  },
};
