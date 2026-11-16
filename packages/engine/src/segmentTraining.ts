import { SegmentTrainingConfigSchema, type SegmentTrainingConfig } from '@darts/schema';
import { trainingEngine } from './trainingCore.ts';
import { legSeed, trainingHint, trainingHit, trainingRandom, type TargetMode } from './trainingShared.ts';
interface SegmentPlayer { score: number; done: boolean }
/** Autodarts Segment Training: an exact zone, or a seeded random zone which
 * changes on a successful hit. Single accepts both singles; Outer Single only
 * the outer area. Hits mode races to the goal; Darts mode gives each player
 * exactly the configured number of actual darts, then compares hits. Three
 * darts per visit, possibly shortened by a completed goal; misses never score.
 * No handicap/elimination. END_MATCH and optional round caps rank hit count. */
function target(cfg: SegmentTrainingConfig, seed: number, hits: number): { number: number; mode: TargetMode } {
  if (cfg.mode !== 'random') return { number: cfg.segment, mode: cfg.mode };
  const random = trainingRandom(seed ^ Math.imul(hits + 1, 2654435761));
  return { number: 1 + Math.floor(random() * 20), mode: (['single', 'double', 'triple'] as const)[Math.floor(random() * 3)]! };
}
export const segmentTrainingEngine = trainingEngine<SegmentTrainingConfig, SegmentPlayer>({
  id: 'segmenttraining', parse: raw => SegmentTrainingConfigSchema.parse(raw), label: 'hits',
  player: () => ({ score: 0, done: false }),
  dart(state, cfg, dart) {
    const id = state.base.players[state.base.activeIndex]!.id; const p = state.players[id]!;
    const aim = target(cfg, legSeed(cfg.seed, state.base), p.score);
    const value = trainingHit(dart.segment, aim.number, aim.mode) ? 1 : 0;
    p.score += value;
    p.done = cfg.endsAfter === 'hits' ? p.score >= cfg.count : state.base.legDarts[id]! >= cfg.count;
    return { value, endTurn: p.done };
  },
  endTurn(state, cfg) {
    const id = state.base.players[state.base.activeIndex]!.id;
    if (cfg.endsAfter === 'hits' && state.players[id]!.done) return { winner: id };
    if (state.base.players.every(p => state.players[p.id]!.done)) return { winner: [...state.base.players].sort((a, b) => state.players[b.id]!.score - state.players[a.id]!.score)[0]!.id };
    return {};
  },
  skip: (state, _cfg, id) => state.players[id]!.done,
  progress: (state, _cfg, id) => state.players[id]!.score,
  detail(state, cfg, id) {
    const p = state.players[id]!; const aim = target(cfg, legSeed(cfg.seed, state.base), p.score);
    return { target: aim.number, targetLabel: trainingHint(aim.number, aim.mode), mode: aim.mode,
      hits: p.score, darts: state.base.legDarts[id] ?? 0, goal: cfg.count, endsAfter: cfg.endsAfter, done: p.done };
  },
  hints(state, cfg) {
    const p = state.players[state.base.players[state.base.activeIndex]!.id]!;
    const aim = target(cfg, legSeed(cfg.seed, state.base), p.score);
    return Array.from({ length: 3 - state.base.turn.length }, () => trainingHint(aim.number, aim.mode));
  },
});
