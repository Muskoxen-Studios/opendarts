import type { DartThrow, DomainEvent, GameConfig, MatchView } from '@darts/schema';
import { activePlayer, addPlayerToBase, advanceTurn, awardLeg, awardLegOnRoundLimit, clone, createBaseState, endMatchEarly, removePlayerFromBase, resetRound, turnIsComplete } from './base.ts';
import { turnDarts } from './trainingShared.ts';
import type { BaseState, GameEngine } from './types.ts';

export interface TrainingState<P> { base: BaseState; players: Record<string, P>; turnValue: number; turnStart: number }
export interface TrainingOutcome { winner?: string | null; nextLeg?: boolean }
interface TrainingRules<C extends GameConfig, P extends { score: number }> {
  id: C['gameType']; parse: (raw: unknown) => C; label: string; solo?: boolean;
  player: (cfg: C, base: BaseState, id: string) => P;
  dart: (state: TrainingState<P>, cfg: C, dart: DartThrow) => { value: number; endTurn?: boolean; bust?: string };
  endTurn?: (state: TrainingState<P>, cfg: C) => TrainingOutcome;
  afterAdvance?: (state: TrainingState<P>, cfg: C) => TrainingOutcome;
  onRoundLimit?: (state: TrainingState<P>, cfg: C) => TrainingOutcome;
  begin?: (state: TrainingState<P>, cfg: C) => void;
  total?: (state: TrainingState<P>, cfg: C) => number;
  skip?: (state: TrainingState<P>, cfg: C, id: string) => boolean;
  progress: (state: TrainingState<P>, cfg: C, id: string) => number;
  result?: (state: TrainingState<P>, cfg: C, id: string) => number;
  detail: (state: TrainingState<P>, cfg: C, id: string) => Record<string, unknown>;
  hints?: (state: TrainingState<P>, cfg: C) => string[];
  continuous?: (cfg: C) => boolean;
  canWin?: (state: TrainingState<P>, cfg: C) => boolean;
}

/** Common forward-only lifecycle for the visit-based practice engines. Rules
 * own all scoring and goals; this owns takeout, replay-safe state, roster,
 * result snapshots, early ending, and the existing leg/set helpers. */
export function trainingEngine<C extends GameConfig, P extends { score: number }>(rules: TrainingRules<C, P>): GameEngine<C, TrainingState<P>> {
  function reset(state: TrainingState<P>, cfg: C): void {
    state.players = Object.fromEntries(state.base.players.map(p => [p.id, rules.player(cfg, state.base, p.id)]));
    state.turnValue = 0; state.turnStart = 0;
  }
  function begin(state: TrainingState<P>, cfg: C): void {
    rules.begin?.(state, cfg);
    state.turnStart = state.players[state.base.players[state.base.activeIndex]?.id ?? '']?.score ?? 0;
    state.turnValue = 0;
  }
  function results(state: TrainingState<P>, cfg: C): DomainEvent[] {
    return state.base.players.map(p => ({ type: 'training.result', playerId: p.id,
      score: rules.result?.(state, cfg, p.id) ?? state.players[p.id]!.score,
      label: rules.label, detail: rules.detail(state, cfg, p.id) }));
  }
  function resolve(state: TrainingState<P>, cfg: C, outcome: TrainingOutcome): DomainEvent[] {
    const base = state.base;
    if (outcome.nextLeg) {
      base.leg++; base.legStartIndex = (base.legStartIndex + 1) % base.players.length;
      base.activeIndex = base.legStartIndex; base.turn = []; base.turnEnded = false;
      for (const p of base.players) base.legDarts[p.id] = 0;
      resetRound(base); reset(state, cfg); begin(state, cfg); return [];
    }
    if (outcome.winner === undefined) return [];
    const events = results(state, cfg);
    if (outcome.winner === null) {
      base.status = 'finished'; base.winnerId = null; base.turn = []; base.turnEnded = false;
    } else {
      events.push(...awardLeg(base, outcome.winner, rules.continuous?.(cfg) ? Number.MAX_SAFE_INTEGER : cfg.legsToWin,
        cfg.setsToWin, () => { reset(state, cfg); begin(state, cfg); }));
    }
    return events;
  }
  function advance(state: TrainingState<P>, cfg: C): DomainEvent[] {
    advanceTurn(state.base, rules.skip ? id => rules.skip!(state, cfg, id) : undefined);
    const outcome = rules.afterAdvance?.(state, cfg) ?? {};
    if (outcome.winner !== undefined || outcome.nextLeg) return resolve(state, cfg, outcome);
    begin(state, cfg);
    if (state.base.round <= (cfg.roundLimit ?? Infinity)) return [];
    if (rules.onRoundLimit) return resolve(state, cfg, rules.onRoundLimit(state, cfg));
    const snapshots = results(state, cfg);
    if (rules.canWin && !rules.canWin(state, cfg)) return resolve(state, cfg, { winner: null });
    return [...snapshots, ...awardLegOnRoundLimit(state.base, cfg, id => rules.progress(state, cfg, id), () => { reset(state, cfg); begin(state, cfg); })];
  }
  function finishTurn(state: TrainingState<P>, cfg: C, immediate: boolean, busted: boolean): DomainEvent[] {
    const id = activePlayer(state.base).id;
    const outcome = rules.endTurn?.(state, cfg) ?? {};
    state.turnValue = busted ? 0 : rules.total?.(state, cfg) ?? state.turnValue;
    const events: DomainEvent[] = [{ type: 'turn.completed', playerId: id,
      total: state.turnValue, darts: state.base.turn.length, busted }];
    if (outcome.winner !== undefined || outcome.nextLeg) events.push(...resolve(state, cfg, outcome));
    else if (immediate) events.push(...advance(state, cfg));
    else state.base.turnEnded = true;
    return events;
  }
  return {
    id: rules.id,
    parseConfig: rules.parse,
    createInitialState(players, cfg) {
      if (rules.solo && players.length !== 1) throw new Error("Bob's 27 requires exactly one player");
      const state: TrainingState<P> = { base: createBaseState(players), players: {}, turnValue: 0, turnStart: 0 };
      reset(state, cfg); return state;
    },
    reduce(prev, cmd, cfg) {
      const state = clone(prev); const base = state.base; const events: DomainEvent[] = [];
      switch (cmd.type) {
        case 'START':
          if (base.status !== 'idle') return { state: prev, events };
          base.status = 'playing'; begin(state, cfg); events.push({ type: 'match.started' }); break;
        case 'THROW': {
          if (base.status !== 'playing' || base.turnEnded) return { state: prev, events };
          const id = activePlayer(base).id;
          base.turn.push(cmd.throw); base.legDarts[id] = (base.legDarts[id] ?? 0) + 1;
          const hit = rules.dart(state, cfg, cmd.throw);
          state.turnValue += hit.value;
          events.push({ type: 'throw.recorded', playerId: id, dartIndex: base.turn.length - 1, value: hit.value });
          if (hit.bust) {
            state.players[id]!.score = state.turnStart; state.turnValue = 0;
            events.push({ type: 'player.busted', playerId: id, reason: hit.bust });
          }
          if (hit.bust || hit.endTurn || turnIsComplete(base)) events.push(...finishTurn(state, cfg, false, Boolean(hit.bust)));
          break;
        }
        case 'NEXT_PLAYER':
          if (base.status !== 'playing') return { state: prev, events };
          events.push(...(base.turnEnded ? advance(state, cfg) : finishTurn(state, cfg, true, false))); break;
        case 'ADVANCE_TURN':
          if (base.status !== 'playing' || !base.turnEnded) return { state: prev, events };
          events.push(...advance(state, cfg)); break;
        case 'RESTART_LEG':
          base.activeIndex = base.legStartIndex; base.turn = []; base.turnEnded = false;
          for (const p of base.players) base.legDarts[p.id] = 0;
          resetRound(base); reset(state, cfg); begin(state, cfg); break;
        case 'END_MATCH':
          if (base.status !== 'playing') return { state: prev, events };
          if (rules.canWin && !rules.canWin(state, cfg)) events.push(...resolve(state, cfg, { winner: null }));
          else { events.push(...results(state, cfg)); events.push(...endMatchEarly(base, id => rules.progress(state, cfg, id))); }
          break;
        case 'ADD_PLAYER':
          if (rules.solo || !addPlayerToBase(base, cmd.player)) return { state: prev, events };
          state.players[cmd.player.id] = rules.player(cfg, base, cmd.player.id);
          events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name }); break;
        case 'REMOVE_PLAYER': {
          const wasActive = base.players[base.activeIndex]?.id === cmd.playerId;
          if (removePlayerFromBase(base, cmd.playerId) === null) return { state: prev, events };
          delete state.players[cmd.playerId];
          if (wasActive) begin(state, cfg);
          events.push({ type: 'player.left', playerId: cmd.playerId }); break;
        }
      }
      return { state, events };
    },
    view(state, cfg, matchId): MatchView {
      const base = state.base;
      const active = base.players[base.activeIndex];
      return { matchId, gameType: rules.id, status: base.status,
        players: base.players.map((p, i) => ({ playerId: p.id, name: p.name, color: p.color,
          score: state.players[p.id]!.score, isActive: base.status === 'playing' && i === base.activeIndex,
          legsWon: base.legsWon[p.id] ?? 0, setsWon: base.setsWon[p.id] ?? 0, checkout: null,
          detail: { trainingLabel: rules.label, ...rules.detail(state, cfg, p.id) },
          stats: { average3: null, dartsThrown: base.legDarts[p.id] ?? 0 } })),
        activePlayerId: base.status === 'playing' ? active?.id ?? null : null, awaitingTakeout: base.turnEnded,
        turn: { throws: turnDarts(base), total: state.turnValue, dartsRemaining: 3 - base.turn.length,
          hints: base.status === 'playing' && !base.turnEnded ? rules.hints?.(state, cfg) ?? [] : [] },
        leg: base.leg, set: base.set, round: base.round, roundLimit: cfg.roundLimit, winnerId: base.winnerId, recent: [] };
    },
  };
}
