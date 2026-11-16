import { CountUpConfigSchema, segmentLabel, type CountUpConfig, type DomainEvent, type Player } from '@darts/schema';
import { activePlayer, addPlayerToBase, advanceTurn, awardLeg, clone, createBaseState, endMatchEarly, removePlayerFromBase, resetRound, turnIsComplete } from './base.ts';
import type { BaseState, GameEngine } from './types.ts';

/** Count Up: start on zero, add every dart's standard board value (25/50 bulls,
 * misses zero), and play three darts per turn. Everyone gets one turn per round,
 * for eight rounds by default. Highest total wins; tied totals use seat order.
 * No bust, elimination or handicap. Rounds (1–100), legs, sets and an optional
 * earlier round limit are configurable. END_MATCH prefers the highest total.
 */
export interface CountUpState {
  base: BaseState;
  scores: Record<string, number>;
  turnStart: Record<string, number>;
  visits: Record<string, number[]>;
}
function seat(state: CountUpState, id: string): void {
  state.scores[id] = 0;
  state.turnStart[id] = 0;
  state.visits[id] = [];
}
function reset(state: CountUpState): void {
  for (const p of state.base.players) seat(state, p.id);
}
function begin(state: CountUpState): void {
  const p = state.base.players[state.base.activeIndex];
  if (p) state.turnStart[p.id] = state.scores[p.id] ?? 0;
}
function rounds(cfg: CountUpConfig): number { return Math.min(cfg.rounds, cfg.roundLimit ?? cfg.rounds); }
function award(state: CountUpState, cfg: CountUpConfig): DomainEvent[] {
  const winner = [...state.base.players].sort((a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0))[0];
  return winner ? awardLeg(state.base, winner.id, cfg.legsToWin, cfg.setsToWin, () => { reset(state); begin(state); }) : [];
}
function handover(state: CountUpState, cfg: CountUpConfig): DomainEvent[] {
  advanceTurn(state.base);
  if (state.base.round > rounds(cfg)) return award(state, cfg);
  begin(state);
  return [];
}
function complete(state: CountUpState, cfg: CountUpConfig, immediate: boolean): DomainEvent[] {
  const base = state.base;
  const id = activePlayer(base).id;
  const total = (state.scores[id] ?? 0) - (state.turnStart[id] ?? 0);
  state.visits[id]!.push(total);
  const events: DomainEvent[] = [{ type: 'turn.completed', playerId: id, total, darts: base.turn.length, busted: false }];
  if (base.round >= rounds(cfg) && base.players.every(p => p.id === id || base.roundTurns.includes(p.id))) {
    events.push(...award(state, cfg));
  } else if (immediate) events.push(...handover(state, cfg));
  else base.turnEnded = true;
  return events;
}
export const countUpEngine: GameEngine<CountUpConfig, CountUpState> = {
  id: 'countup',
  parseConfig: raw => CountUpConfigSchema.parse(raw),
  createInitialState(players: Player[]) {
    const state: CountUpState = { base: createBaseState(players), scores: {}, turnStart: {}, visits: {} };
    reset(state);
    return state;
  },
  reduce(prev, cmd, cfg) {
    const state = clone(prev);
    const base = state.base;
    const events: DomainEvent[] = [];
    switch (cmd.type) {
      case 'START':
        if (base.status !== 'idle') return { state: prev, events };
        base.status = 'playing'; begin(state); events.push({ type: 'match.started' }); break;
      case 'THROW': {
        if (base.status !== 'playing' || base.turnEnded) return { state: prev, events };
        const id = activePlayer(base).id;
        base.turn.push(cmd.throw);
        base.legDarts[id] = (base.legDarts[id] ?? 0) + 1;
        state.scores[id] = (state.scores[id] ?? 0) + cmd.throw.value;
        events.push({ type: 'throw.recorded', playerId: id, dartIndex: base.turn.length - 1, value: cmd.throw.value });
        if (turnIsComplete(base)) events.push(...complete(state, cfg, false));
        break;
      }
      case 'NEXT_PLAYER':
        if (base.status !== 'playing') return { state: prev, events };
        events.push(...(base.turnEnded ? handover(state, cfg) : complete(state, cfg, true))); break;
      case 'ADVANCE_TURN':
        if (base.status !== 'playing' || !base.turnEnded) return { state: prev, events };
        events.push(...handover(state, cfg)); break;
      case 'RESTART_LEG':
        base.activeIndex = base.legStartIndex; base.turn = []; base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetRound(base); reset(state); begin(state); break;
      case 'END_MATCH': events.push(...endMatchEarly(base, id => state.scores[id] ?? 0)); break;
      case 'ADD_PLAYER':
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events };
        seat(state, cmd.player.id);
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name }); break;
      case 'REMOVE_PLAYER': {
        const wasActive = base.players[base.activeIndex]?.id === cmd.playerId;
        if (removePlayerFromBase(base, cmd.playerId) === null) return { state: prev, events };
        delete state.scores[cmd.playerId]; delete state.turnStart[cmd.playerId]; delete state.visits[cmd.playerId];
        if (wasActive) begin(state);
        events.push({ type: 'player.left', playerId: cmd.playerId }); break;
      }
    }
    return { state, events };
  },
  view(state, cfg, matchId) {
    const base = state.base;
    const active = base.players[base.activeIndex];
    return {
      matchId, gameType: 'countup', status: base.status,
      players: base.players.map((p, i) => ({
        playerId: p.id, name: p.name, color: p.color, score: state.scores[p.id] ?? 0,
        isActive: base.status === 'playing' && i === base.activeIndex,
        legsWon: base.legsWon[p.id] ?? 0, setsWon: base.setsWon[p.id] ?? 0, checkout: null,
        detail: { rounds: rounds(cfg), visits: state.visits[p.id] ?? [] },
        stats: { average3: base.legDarts[p.id] ? (state.scores[p.id] ?? 0) * 3 / base.legDarts[p.id]! : null, dartsThrown: base.legDarts[p.id] ?? 0 },
      })),
      activePlayerId: base.status === 'playing' ? active?.id ?? null : null,
      awaitingTakeout: base.turnEnded,
      turn: { throws: base.turn.map(d => ({ id: d.id, label: segmentLabel(d.segment), value: d.value, coords: d.coords })),
        total: active ? (state.scores[active.id] ?? 0) - (state.turnStart[active.id] ?? 0) : 0,
        dartsRemaining: 3 - base.turn.length, hints: [] },
      leg: base.leg, set: base.set, round: base.round, roundLimit: rounds(cfg), winnerId: base.winnerId, recent: [],
    };
  },
};
