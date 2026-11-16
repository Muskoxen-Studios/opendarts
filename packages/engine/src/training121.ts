import { Training121ConfigSchema, type Training121Config } from '@darts/schema';
import { suggestCheckout } from './checkout.ts';
import { trainingEngine, type TrainingState } from './trainingCore.ts';
import { outSatisfied } from './trainingShared.ts';
interface Climber { score: number; level: number; safehouse: number; highest: number; checkouts: number; turns: number; attempts: number; pending: boolean }
const leader = (state: TrainingState<Climber>) => [...state.base.players].sort((a, b) => state.players[b.id]!.level - state.players[a.id]!.level)[0]!.id;
/** Autodarts 121: start at 121, double-out within 6/9 darts (2/3 visits),
 * climbing by Step after success. A bust restores only this visit and consumes
 * it. Failure after all visits drops one (floor 121), resets to 121, or returns
 * to a banked safehouse; banks update after every N successful checkouts.
 * Attempts run per player for Max Rounds. Checking out 170 wins immediately;
 * otherwise final level leads, with no winner when nobody finishes above 121.
 * Three-dart turns and normal takeout, no handicap/elimination; completed
 * attempt budgets skip players. END_MATCH/round caps use current level. */
export const training121Engine = trainingEngine<Training121Config, Climber>({
  id: '121', parse: raw => Training121ConfigSchema.parse(raw), label: 'level',
  player: () => ({ score: 121, level: 121, safehouse: 121, highest: 121, checkouts: 0, turns: 0, attempts: 0, pending: false }),
  begin(state) {
    const p = state.players[state.base.players[state.base.activeIndex]?.id ?? ''];
    if (p?.pending) { p.score = p.level; p.turns = 0; p.pending = false; }
  },
  dart(state, _cfg, dart) {
    const p = state.players[state.base.players[state.base.activeIndex]!.id]!;
    const next = p.score - dart.value;
    if (next < 0 || next === 1 || (next === 0 && !outSatisfied(dart.segment, 'double'))) return { value: 0, bust: 'Double out required; visit restored' };
    p.score = next; return { value: dart.value, endTurn: next === 0 };
  },
  endTurn(state, cfg) {
    const id = state.base.players[state.base.activeIndex]!.id; const p = state.players[id]!;
    p.turns++;
    if (p.score === 0) {
      p.checkouts++; p.attempts++;
      if (p.level === 170) return { winner: id };
      p.level = Math.min(170, p.level + cfg.step); p.highest = Math.max(p.highest, p.level);
      if (cfg.onFail === 'safehouse' && p.checkouts % cfg.safehouseEvery === 0) p.safehouse = p.level;
      p.pending = true;
    } else if (p.turns >= cfg.dartMode / 3) {
      p.attempts++; p.level = cfg.onFail === 'hard' ? 121 : cfg.onFail === 'safehouse' ? p.safehouse : Math.max(121, p.level - 1);
      p.pending = true;
    }
    if (state.base.players.every(p => state.players[p.id]!.attempts >= cfg.maxRounds)) {
      return { winner: state.base.players.some(p => state.players[p.id]!.level > 121) ? leader(state) : null };
    }
    return {};
  },
  skip: (state, cfg, id) => state.players[id]!.attempts >= cfg.maxRounds,
  canWin: state => state.base.players.some(p => state.players[p.id]!.level > 121),
  progress: (state, _cfg, id) => state.players[id]!.level,
  result: (state, _cfg, id) => state.players[id]!.level,
  detail: (state, cfg, id) => ({ level: state.players[id]!.level, safehouse: state.players[id]!.safehouse,
    highest: state.players[id]!.highest, checkouts: state.players[id]!.checkouts,
    turnsUsed: state.players[id]!.turns, visitsPerAttempt: cfg.dartMode / 3,
    attempts: state.players[id]!.attempts, maxRounds: cfg.maxRounds, pending: state.players[id]!.pending }),
  hints: state => suggestCheckout(state.players[state.base.players[state.base.activeIndex]!.id]!.score, 3 - state.base.turn.length, 'double') ?? [],
});
