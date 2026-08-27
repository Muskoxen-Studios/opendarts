import {
  EvenOddConfigSchema,
  segmentLabel,
  type DomainEvent,
  type EvenOddConfig,
  type MatchView,
  type Player,
  type PlayerView,
  type Segment,
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
 * Even/Odd.
 *
 * Every dart moves a player's score: an even wedge adds its scored value
 * (ring multiplier included -- D6 is +12, T6 is +18), an odd wedge subtracts
 * it, and a miss does nothing. Bulls are split like any other pair of
 * adjacent values -- 25 (outer bull) is odd and subtracts, 50 (inner bull) is
 * even and adds. Scores can go negative; there is no floor. The first player
 * to reach or cross the target score wins the leg outright, mid-turn if need
 * be -- the same instant-win shape as Shanghai, just checked against a
 * running total instead of a round's hits.
 */

export interface EvenOddState {
  base: BaseState;
  scores: Record<string, number>;
  turnStartScore: Record<string, number>;
}

function isEven(segment: Segment): boolean {
  if (segment.ring === 'BULL') return true; // inner bull, 50 -- even
  if (segment.ring === 'OUTER_BULL') return false; // 25 -- odd
  return segment.number % 2 === 0; // MISS is number 0, but its value is 0 either way
}

function seatPlayer(state: EvenOddState, playerId: string, cfg: EvenOddConfig): void {
  state.scores[playerId] = cfg.startingScore;
  state.turnStartScore[playerId] = cfg.startingScore;
}

function resetLeg(state: EvenOddState, cfg: EvenOddConfig): void {
  for (const p of state.base.players) seatPlayer(state, p.id, cfg);
}

function beginTurn(state: EvenOddState): void {
  const p = state.base.players[state.base.activeIndex];
  if (!p) return;
  state.turnStartScore[p.id] = state.scores[p.id] ?? 0;
}

/** How well a player is doing -- higher is always better, since the target is a ceiling to reach. */
function progress(state: EvenOddState, playerId: string): number {
  return state.scores[playerId] ?? 0;
}

export const evenOddEngine: GameEngine<EvenOddConfig, EvenOddState> = {
  id: 'evenodd',

  parseConfig(raw) {
    return EvenOddConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: EvenOddConfig): EvenOddState {
    const state: EvenOddState = {
      base: createBaseState(players),
      scores: {},
      turnStartScore: {},
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<EvenOddState> {
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
        advanceTurn(base);
        beginTurn(state);
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
        seatPlayer(state, cmd.player.id, cfg);
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.scores[cmd.playerId];
        delete state.turnStartScore[cmd.playerId];
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (base.players.length > 0 && base.status === 'playing') beginTurn(state);
        return { state, events };
      }

      case 'END_MATCH': {
        events.push(...endMatchEarly(base, (id) => progress(state, id)));
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

        const delta = isEven(dart.segment) ? dart.value : -dart.value;
        state.scores[player.id] = (state.scores[player.id] ?? 0) + delta;

        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value: delta,
        });

        if ((state.scores[player.id] ?? 0) >= cfg.targetScore) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
            darts: base.turn.length,
            busted: false,
          });
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
          base.turnEnded = true;
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
          targetScore: cfg.targetScore,
        },
        stats: {
          average3: darts > 0 ? ((state.scores[p.id] ?? 0) / darts) * 3 : null,
          dartsThrown: darts,
        },
      };
    });

    return {
      matchId,
      gameType: 'evenodd',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value, coords: t.coords })),
        total: active ? (state.scores[active.id] ?? 0) - (state.turnStartScore[active.id] ?? 0) : 0,
        dartsRemaining: dartsLeft,
        hints: [],
      },
      leg: base.leg,
      set: base.set,
      round: base.round,
      roundLimit: cfg.roundLimit,
      winnerId: base.winnerId,
      recent: [],
    };
  },
};
