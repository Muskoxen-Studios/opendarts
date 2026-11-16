import { Bobs27ConfigSchema, type Bobs27Config } from '@darts/schema';
import { trainingEngine } from './trainingCore.ts';
interface BobPlayer { score: number; hits: number; highest: number; visits: number[] }
/** Autodarts Bob's 27 is solo-only: start at 27 and take three darts at each
 * double 1–20, optionally inner bull. Each hit adds its double value; a visit
 * without a hit subtracts it once. Normal mode ends with no win at zero or
 * below; Allow Negative continues. Completing the sequence with a positive
 * score wins the leg; a non-positive final result is saved without a win.
 * Legs/sets/restart are supported; no late joins or handicap. END_MATCH/round
 * limits rank score, recording no win if the solo score is non-positive. */
export const bobs27Engine = trainingEngine<Bobs27Config, BobPlayer>({
  id: 'bobs27', parse: raw => Bobs27ConfigSchema.parse(raw), label: 'points', solo: true,
  player: () => ({ score: 27, hits: 0, highest: 27, visits: [] }),
  dart(state, _cfg, dart) {
    const p = state.players[state.base.players[0]!.id]!;
    const target = state.base.round <= 20 ? state.base.round : 25;
    const hit = dart.segment.number === target && (target === 25 ? dart.segment.ring === 'BULL' : dart.segment.ring === 'DOUBLE');
    const value = hit ? target * 2 : 0;
    p.score += value; if (hit) p.hits++;
    p.highest = Math.max(p.highest, p.score); return { value };
  },
  endTurn(state, cfg) {
    const id = state.base.players[0]!.id; const p = state.players[id]!;
    const value = (state.base.round <= 20 ? state.base.round : 25) * 2;
    if (state.turnValue === 0) p.score -= value;
    p.visits.push(p.score - state.turnStart);
    if (!cfg.allowNegative && p.score <= 0) return { winner: null };
    return state.base.round >= (cfg.finishBull ? 21 : 20) ? { winner: p.score > 0 ? id : null } : {};
  },
  total: state => state.players[state.base.players[0]!.id]!.score - state.turnStart,
  canWin: state => state.players[state.base.players[0]!.id]!.score > 0,
  progress: (state, _cfg, id) => state.players[id]!.score,
  detail: (state, cfg, id) => ({ target: state.base.round <= 20 ? state.base.round : 25,
    targetLabel: state.base.round <= 20 ? `D${state.base.round}` : 'BULL',
    hits: state.players[id]!.hits, darts: state.base.legDarts[id] ?? 0,
    highest: state.players[id]!.highest, visits: state.players[id]!.visits,
    rounds: cfg.finishBull ? 21 : 20, eliminated: !cfg.allowNegative && state.players[id]!.score <= 0 }),
  hints: state => Array.from({ length: 3 - state.base.turn.length }, () => state.base.round <= 20 ? `D${state.base.round}` : 'BULL'),
});
