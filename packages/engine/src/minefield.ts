import {
  MinefieldConfigSchema,
  MINEFIELD_INITIAL_MULTIPLIER,
  MINEFIELD_MULTIPLIER_STEP,
  minefieldHitPoints,
  MINEFIELD_TARGETS,
  segmentLabel,
  type DomainEvent,
  type MinefieldConfig,
  type MatchView,
  type Player,
  type PlayerView,
} from '@darts/schema';
import {
  activePlayer,
  addPlayerToBase,
  advanceTurn,
  awardLeg,
  awardLegOnRoundLimit,
  resetRound,
  clone,
  createBaseState,
  endMatchEarly,
  removePlayerFromBase,
  turnIsComplete,
} from './base.ts';
import type { BaseState, EngineResult, ForwardCommand, GameEngine } from './types.ts';

/** Shared numbers wear down, explode on the next hit, then immediately recover. */
export interface MinefieldNumber {
  number: number;
  hp: number;
  multiplier: number;
}

export interface MinefieldState {
  base: BaseState;
  field: Record<number, MinefieldNumber>;
  hitPoints: number;
  turnValues: number[];
  scores: Record<string, number>;
  turnStartScore: Record<string, number>;
}

function seatPlayer(state: MinefieldState, playerId: string): void {
  state.scores[playerId] = 0;
  state.turnStartScore[playerId] = 0;
}

function resetLeg(state: MinefieldState, cfg: MinefieldConfig): void {
  state.hitPoints = cfg.hitPoints ?? minefieldHitPoints(state.base.players.length);
  for (const p of state.base.players) seatPlayer(state, p.id);
  state.field = Object.fromEntries(MINEFIELD_TARGETS.map((number) => [
    number, { number, hp: state.hitPoints, multiplier: MINEFIELD_INITIAL_MULTIPLIER },
  ]));
}

function beginTurn(state: MinefieldState): void {
  state.turnValues = [];
  const p = state.base.players[state.base.activeIndex];
  if (!p) return;
  state.turnStartScore[p.id] = state.scores[p.id] ?? 0;
}

/** How well a player is doing -- higher is always better, since the target is a ceiling to reach. */
function progress(state: MinefieldState, playerId: string): number {
  return state.scores[playerId] ?? 0;
}

function checkRoundLimit(state: MinefieldState, cfg: MinefieldConfig): DomainEvent[] {
  return awardLegOnRoundLimit(state.base, cfg, (id) => progress(state, id), () => {
    resetLeg(state, cfg);
    beginTurn(state);
  });
}

export const minefieldEngine: GameEngine<MinefieldConfig, MinefieldState> = {
  id: 'minefield',

  parseConfig(raw) {
    return MinefieldConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: MinefieldConfig): MinefieldState {
    const state: MinefieldState = {
      base: createBaseState(players),
      field: {},
      hitPoints: 0,
      turnValues: [],
      scores: {},
      turnStartScore: {},
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<MinefieldState> {
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
          events.push(...checkRoundLimit(state, cfg));
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
        events.push(...checkRoundLimit(state, cfg));
        beginTurn(state);
        return { state, events };
      }

      case 'ADVANCE_TURN': {
        if (!base.turnEnded) return { state: prev, events: [] };
        advanceTurn(base);
        events.push(...checkRoundLimit(state, cfg));
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
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (removed === prev.base.activeIndex && base.players.length > 0 && base.status === 'playing') {
          beginTurn(state);
        }
        return { state, events };
      }

      case 'END_MATCH': {
        events.push(...endMatchEarly(base, (id) => progress(state, id)));
        return { state, events };
      }

      case 'RESTART_LEG': {
        resetRound(base);
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

        const number = state.field[dart.segment.number];
        let delta = dart.value;
        if (dart.segment.ring !== 'MISS' && number) {
          if (number.hp > 0) {
            // The arming dart still scores normally, including doubles/triples.
            number.hp -= 1;
          } else {
            // Round the positive penalty first so .5 always rounds up, even when subtracted.
            delta = -Math.round(number.number * number.multiplier);
            number.hp = state.hitPoints;
            number.multiplier += MINEFIELD_MULTIPLIER_STEP;
          }
        }
        state.turnValues.push(delta);
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
          hitPoints: state.hitPoints,
          field: MINEFIELD_TARGETS.map((number) => {
            const cell = state.field[number]!;
            return {
              ...cell,
              nextMultiplier: cell.hp === 0 ? cell.multiplier : null,
            };
          }),
        },
        stats: {
          average3: darts > 0 ? ((state.scores[p.id] ?? 0) / darts) * 3 : null,
          dartsThrown: darts,
        },
      };
    });

    return {
      matchId,
      gameType: 'minefield',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t, i) => ({ id: t.id, label: segmentLabel(t.segment), value: state.turnValues[i] ?? 0, coords: t.coords })),
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
