import { RandomCheckoutConfigSchema, type RandomCheckoutConfig } from '@darts/schema';
import { suggestCheckout } from './checkout.ts';
import { trainingEngine } from './trainingCore.ts';
import { legSeed, outSatisfied, trainingRandom } from './trainingShared.ts';
interface CheckoutPlayer { score: number; start: number; turns: number }
/** Autodarts Random Checkout: the same seeded random total for everyone each
 * leg. Standard X01 bust/finish rules, configurable Straight/Double/Master out,
 * and a per-player visit budget. First checkout takes the leg; exhausting all
 * budgets awards nobody. Continuous practice (default) starts another target
 * after a failed leg's takeout or a checkout; End game ranks legs actually won,
 * with no winner when none were checked out. Finite legs/sets are optional.
 * No handicap/elimination; exhausted budgets skip that player for this leg. */
export const randomCheckoutEngine = trainingEngine<RandomCheckoutConfig, CheckoutPlayer>({
  id: 'randomcheckout', parse: raw => RandomCheckoutConfigSchema.parse(raw), label: 'legs',
  player(cfg, base) {
    const score = cfg.checkoutMin + Math.floor(trainingRandom(legSeed(cfg.seed, base))() * (cfg.checkoutMax - cfg.checkoutMin + 1));
    return { score, start: score, turns: 0 };
  },
  dart(state, cfg, dart) {
    const p = state.players[state.base.players[state.base.activeIndex]!.id]!;
    const next = p.score - dart.value;
    const bust = next < 0 || (cfg.outMode !== 'straight' && next === 1) || (next === 0 && !outSatisfied(dart.segment, cfg.outMode));
    if (bust) return { value: 0, bust: `finish requires ${cfg.outMode}; turn restored` };
    p.score = next; return { value: dart.value, endTurn: next === 0 };
  },
  endTurn(state, cfg) {
    const id = state.base.players[state.base.activeIndex]!.id; const p = state.players[id]!; p.turns++;
    if (p.score === 0) return { winner: id };
    if (!cfg.continuous && state.base.players.every(p => state.players[p.id]!.turns >= cfg.maxRounds)) return { winner: null };
    return {};
  },
  afterAdvance: (state, cfg) => state.base.players.every(p => state.players[p.id]!.turns >= cfg.maxRounds) ? { nextLeg: true } : {},
  onRoundLimit: (_state, cfg) => cfg.continuous ? { nextLeg: true } : { winner: null },
  continuous: cfg => cfg.continuous,
  skip: (state, cfg, id) => state.players[id]!.turns >= cfg.maxRounds,
  canWin: state => state.base.players.some(p => (state.base.legsWon[p.id] ?? 0) > 0 || (state.base.setsWon[p.id] ?? 0) > 0),
  progress: () => 0,
  result: (state, _cfg, id) => (state.base.legsWon[id] ?? 0) + (state.players[id]!.score === 0 ? 1 : 0),
  detail: (state, cfg, id) => ({ remaining: state.players[id]!.score, startScore: state.players[id]!.start,
    turnsUsed: state.players[id]!.turns, maxRounds: cfg.maxRounds, continuous: cfg.continuous, outMode: cfg.outMode }),
  hints(state, cfg) { return suggestCheckout(state.players[state.base.players[state.base.activeIndex]!.id]!.score, 3 - state.base.turn.length, cfg.outMode) ?? []; },
});
