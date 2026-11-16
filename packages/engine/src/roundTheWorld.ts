import { RoundTheWorldConfigSchema, type RoundTheWorldConfig } from '@darts/schema';
import { trainingEngine } from './trainingCore.ts';
import { legSeed, trainingSequence } from './trainingShared.ts';

/** Autodarts Round the World: one three-dart visit per numbered target, then
 * bull by default. Singles/doubles/trebles earn 1/2/3 marks; bull rings 1/2.
 * Advance even on misses, sharing each round across the roster. Highest total
 * after everyone's final visit wins (seat order breaks ties). Ascending,
 * descending or seeded random order; optional bull, legs/sets and round cap.
 * No elimination/handicaps. END_MATCH ranks marks, not raw board points. */
interface WorldPlayer { score: number; hits: number; visits: number[] }
const targets = (cfg: RoundTheWorldConfig, base: Parameters<typeof legSeed>[1]) => trainingSequence(cfg.order, cfg.finishBull, legSeed(cfg.seed, base));
export const roundTheWorldEngine = trainingEngine<RoundTheWorldConfig, WorldPlayer>({
  id: 'roundtheworld', parse: raw => RoundTheWorldConfigSchema.parse(raw), label: 'marks',
  player: () => ({ score: 0, hits: 0, visits: [] }),
  dart(state, cfg, dart) {
    const p = state.players[state.base.players[state.base.activeIndex]!.id]!;
    const target = targets(cfg, state.base)[state.base.round - 1];
    const hit = dart.segment.number === target && dart.segment.ring !== 'MISS';
    const value = !hit ? 0 : dart.segment.ring === 'TRIPLE' ? 3 : dart.segment.ring === 'DOUBLE' || dart.segment.ring === 'BULL' ? 2 : 1;
    p.score += value; if (hit) p.hits++;
    return { value };
  },
  endTurn(state, cfg) {
    const id = state.base.players[state.base.activeIndex]!.id;
    state.players[id]!.visits.push(state.turnValue);
    if (state.base.round >= targets(cfg, state.base).length && state.base.players.every(p => p.id === id || state.base.roundTurns.includes(p.id))) {
      return { winner: [...state.base.players].sort((a, b) => state.players[b.id]!.score - state.players[a.id]!.score)[0]!.id };
    }
    return {};
  },
  afterAdvance(state, cfg) {
    return state.base.round > targets(cfg, state.base).length
      ? { winner: [...state.base.players].sort((a, b) => state.players[b.id]!.score - state.players[a.id]!.score)[0]!.id } : {};
  },
  progress: (state, _cfg, id) => state.players[id]!.score,
  detail: (state, cfg, id) => ({ target: targets(cfg, state.base)[state.base.round - 1] ?? null,
    sequence: targets(cfg, state.base), visits: state.players[id]!.visits, hits: state.players[id]!.hits,
    darts: state.base.legDarts[id] ?? 0, rounds: targets(cfg, state.base).length }),
  hints: (state, cfg) => Array.from({ length: 3 - state.base.turn.length }, () => String(targets(cfg, state.base)[state.base.round - 1])),
});
