import { AroundTheClockConfigSchema, type AroundTheClockConfig } from '@darts/schema';
import { trainingEngine } from './trainingCore.ts';
import { legSeed, trainingHint, trainingHit, trainingSequence } from './trainingShared.ts';
interface ClockPlayer { score: number; hits: number; partial: number }
/** Autodarts Around the Clock: independent 1–20 sequences then bull by default,
 * ascending, descending or seeded random. Full/Single/Outer Single/Double/Triple
 * modes and 1–3 required hits per target. Multipliers never skip targets.
 * Full accepts either bull; single modes require outer bull; double/triple
 * practice ends on inner bull (there is no triple bull). Three darts per turn,
 * no bonus turns, elimination or handicaps. First complete sequence wins;
 * END_MATCH/round caps rank completed targets then partial hits, ties by seat.
 */
const sequence = (cfg: AroundTheClockConfig, base: Parameters<typeof legSeed>[1]) => trainingSequence(cfg.order, cfg.finishBull, legSeed(cfg.seed, base));
export const aroundTheClockEngine = trainingEngine<AroundTheClockConfig, ClockPlayer>({
  id: 'aroundtheclock', parse: raw => AroundTheClockConfigSchema.parse(raw), label: 'hits',
  player: () => ({ score: 0, hits: 0, partial: 0 }),
  dart(state, cfg, dart) {
    const p = state.players[state.base.players[state.base.activeIndex]!.id]!;
    const target = sequence(cfg, state.base)[p.score];
    const hit = target !== undefined && trainingHit(dart.segment, target, cfg.mode);
    if (hit) { p.hits++; p.partial++; if (p.partial >= cfg.hits) { p.score++; p.partial = 0; } }
    return { value: hit ? 1 : 0, endTurn: p.score === sequence(cfg, state.base).length };
  },
  endTurn(state, cfg) {
    const id = state.base.players[state.base.activeIndex]!.id;
    return state.players[id]!.score === sequence(cfg, state.base).length ? { winner: id } : {};
  },
  progress: (state, cfg, id) => state.players[id]!.score * cfg.hits + state.players[id]!.partial,
  result: (state, _cfg, id) => state.players[id]!.hits,
  detail(state, cfg, id) {
    const p = state.players[id]!; const targets = sequence(cfg, state.base); const target = targets[p.score] ?? null;
    return { target, targetLabel: target === null ? 'DONE' : trainingHint(target, cfg.mode),
      sequence: targets, completed: p.score, targets: targets.length, mode: cfg.mode,
      hitsRequired: cfg.hits, hitsOnTarget: p.partial, successfulHits: p.hits,
      hits: p.hits, darts: state.base.legDarts[id] ?? 0,
      hitRate: state.base.legDarts[id] ? p.hits / state.base.legDarts[id]! : null };
  },
  hints(state, cfg) {
    const p = state.players[state.base.players[state.base.activeIndex]!.id]!; const target = sequence(cfg, state.base)[p.score];
    return target === undefined ? [] : Array.from({ length: 3 - state.base.turn.length }, () => trainingHint(target, cfg.mode));
  },
});
export type AroundTheClockState = Parameters<typeof aroundTheClockEngine.view>[0];
