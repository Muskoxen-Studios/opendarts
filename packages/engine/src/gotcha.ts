import {
  GotchaConfigSchema,
  segmentLabel,
  type DomainEvent,
  type GotchaConfig,
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

export interface GotchaState {
  base: BaseState;
  scores: Record<string, number>;
  /**
   * Each player's score at the start of their most recent turn.
   *
   * Serves two purposes: restoring after a bust, and providing the target for
   * `knockback: 'previousTurn'` when this player is knocked back by someone else.
   */
  turnStartScore: Record<string, number>;
}

function beginTurn(state: GotchaState): void {
  const p = activePlayer(state.base);
  state.turnStartScore[p.id] = state.scores[p.id] ?? 0;
}

/** A player's optional handicap head start, clamped into the valid range for this target. */
function startingScore(cfg: GotchaConfig, playerId: string): number {
  const h = cfg.handicaps[playerId] ?? 0;
  return Math.max(0, Math.min(cfg.target - 1, h));
}

function resetLeg(state: GotchaState, cfg: GotchaConfig): void {
  for (const p of state.base.players) {
    state.scores[p.id] = startingScore(cfg, p.id);
    state.turnStartScore[p.id] = state.scores[p.id]!;
  }
}

export const gotchaEngine: GameEngine<GotchaConfig, GotchaState> = {
  id: 'gotcha',

  parseConfig(raw) {
    return GotchaConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: GotchaConfig): GotchaState {
    const state: GotchaState = {
      base: createBaseState(players),
      scores: {},
      turnStartScore: {},
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<GotchaState> {
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
        state.scores[cmd.player.id] = startingScore(cfg, cmd.player.id);
        state.turnStartScore[cmd.player.id] = state.scores[cmd.player.id]!;
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
        // Counting up: the highest score is the closest to the target.
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

        const score = state.scores[player.id] ?? 0;
        const next = score + dart.value;

        // Overshooting the target busts the whole turn.
        if (cfg.exactFinish && next > cfg.target) {
          state.scores[player.id] = state.turnStartScore[player.id] ?? 0;
          events.push({
            type: 'throw.recorded',
            playerId: player.id,
            dartIndex: base.turn.length - 1,
            value: 0,
          });
          events.push({
            type: 'player.busted',
            playerId: player.id,
            reason: `overshot ${cfg.target}`,
          });
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: 0,
            darts: base.turn.length,
            busted: true,
          });
          base.turnEnded = true;
          return { state, events };
        }

        state.scores[player.id] = next;
        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value: dart.value,
        });

        const won = cfg.exactFinish ? next === cfg.target : next >= cfg.target;

        // The 'ludo' mechanic: landing exactly on an opponent's total sends
        // them backwards. Only applies to opponents who are actually on the
        // board -- you cannot knock back someone sitting on zero.
        if (!won && next > 0) {
          for (const opp of base.players) {
            if (opp.id === player.id) continue;
            const oppScore = state.scores[opp.id] ?? 0;
            if (oppScore !== next || oppScore === 0) continue;

            const to = cfg.knockback === 'zero' ? 0 : (state.turnStartScore[opp.id] ?? 0);
            if (to === oppScore) continue;
            state.scores[opp.id] = to;
            events.push({
              type: 'gotcha.knockback',
              byPlayerId: player.id,
              victimPlayerId: opp.id,
              from: oppScore,
              to,
            });
          }
        }

        if (won) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: next - (state.turnStartScore[player.id] ?? 0),
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
            total: next - (state.turnStartScore[player.id] ?? 0),
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

    const players: PlayerView[] = base.players.map((p, i) => {
      const darts = base.legDarts[p.id] ?? 0;
      const score = state.scores[p.id] ?? 0;
      return {
        playerId: p.id,
        name: p.name,
        color: p.color,
        score,
        isActive: i === base.activeIndex && base.status === 'playing',
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: null,
        detail: {
          target: cfg.target,
          remaining: cfg.target - score,
          knockback: cfg.knockback,
        },
        stats: {
          average3: darts > 0 ? (score / darts) * 3 : null,
          dartsThrown: darts,
        },
      };
    });

    return {
      matchId,
      gameType: 'gotcha',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value, coords: t.coords })),
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
