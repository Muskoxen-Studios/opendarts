import {
  GOLF_BASE_HANDICAP,
  GolfConfigSchema,
  segmentLabel,
  type DomainEvent,
  type GolfConfig,
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

/**
 * Golf, scored Stableford.
 *
 * Holes 1..18 are the board numbers 1..18. Every dart is a stroke and the hole
 * is holed the moment the player hits that number in any ring, so a first-dart
 * hit on a par-4 hole is three under -- an albatross. A hole is abandoned once
 * the player is one stroke over their personal par without hitting it.
 *
 * Handicap strokes are dealt out one hole at a time from hole 1, so a handicap
 * of 20 over 18 holes gives two extra strokes on holes 1 and 2 and one
 * everywhere else. Playing every hole to personal par scores 2 points a hole,
 * i.e. 36 -- which is exactly what a handicap of 36 predicts, and why that is
 * the number a new player starts on.
 */

export interface GolfHoleResult {
  hole: number;
  /** This player's par for the hole, after handicap strokes. */
  par: number;
  strokes: number;
  points: number;
  /** False when the hole was abandoned at par + 1 without a hit. */
  holed: boolean;
}

export interface GolfState {
  base: BaseState;
  /** Hole currently being played, 1-based. Past `cfg.holes` means round over. */
  hole: Record<string, number>;
  /** Darts already spent on the current hole. Carries across turns. */
  strokes: Record<string, number>;
  points: Record<string, number>;
  results: Record<string, GolfHoleResult[]>;
  /** Points at the start of the active turn, so a turn total can be reported. */
  turnStartPoints: Record<string, number>;
}

/** The handicap this player is playing off, defaulting to a newcomer's 36. */
export function handicapOf(cfg: GolfConfig, playerId: string): number {
  return cfg.handicaps[playerId] ?? GOLF_BASE_HANDICAP;
}

/**
 * Handicap strokes allocated to one hole.
 *
 * The handicap is spread evenly and the remainder handed out from hole 1
 * upwards, so the earlier holes are the generous ones.
 */
export function strokeAllowance(handicap: number, holes: number, hole: number): number {
  if (holes <= 0) return 0;
  const flat = Math.floor(handicap / holes);
  const extra = handicap % holes;
  return flat + (hole <= extra ? 1 : 0);
}

export function personalPar(cfg: GolfConfig, playerId: string, hole: number): number {
  return cfg.par + strokeAllowance(handicapOf(cfg, playerId), cfg.holes, hole);
}

/**
 * Stableford points for a completed hole.
 *
 * 3 under par is an albatross at 5 points, down to a single point for one over.
 * Anything worse scores nothing, which is why the hole is abandoned there.
 */
export function stablefordPoints(par: number, strokes: number, holed: boolean): number {
  if (!holed) return 0;
  const under = par - strokes;
  if (under >= 3) return 5;
  if (under === 2) return 4;
  if (under === 1) return 3;
  if (under === 0) return 2;
  if (under === -1) return 1;
  return 0;
}

/** Points a player would score by playing every remaining hole to par. */
export function parPoints(holes: number): number {
  return holes * 2;
}

function isDone(state: GolfState, cfg: GolfConfig, playerId: string): boolean {
  return (state.hole[playerId] ?? 1) > cfg.holes;
}

function makeSkip(state: GolfState, cfg: GolfConfig): (playerId: string) => boolean {
  return (playerId: string) => isDone(state, cfg, playerId);
}

function beginTurn(state: GolfState): void {
  const p = state.base.players[state.base.activeIndex];
  if (!p) return;
  state.turnStartPoints[p.id] = state.points[p.id] ?? 0;
}

function seatPlayer(state: GolfState, playerId: string): void {
  state.hole[playerId] = 1;
  state.strokes[playerId] = 0;
  state.points[playerId] = 0;
  state.results[playerId] = [];
  state.turnStartPoints[playerId] = 0;
}

function resetLeg(state: GolfState): void {
  for (const p of state.base.players) seatPlayer(state, p.id);
}

export const golfEngine: GameEngine<GolfConfig, GolfState> = {
  id: 'golf',

  parseConfig(raw) {
    return GolfConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], _cfg: GolfConfig): GolfState {
    const state: GolfState = {
      base: createBaseState(players),
      hole: {},
      strokes: {},
      points: {},
      results: {},
      turnStartPoints: {},
    };
    resetLeg(state);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<GolfState> {
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
          advanceTurn(base, makeSkip(state, cfg));
          beginTurn(state);
          return { state, events };
        }
        const p = activePlayer(base);
        events.push({
          type: 'turn.completed',
          playerId: p.id,
          total: (state.points[p.id] ?? 0) - (state.turnStartPoints[p.id] ?? 0),
          darts: base.turn.length,
          busted: false,
        });
        advanceTurn(base, makeSkip(state, cfg));
        beginTurn(state);
        return { state, events };
      }

      case 'ADVANCE_TURN': {
        if (!base.turnEnded) return { state: prev, events: [] };
        advanceTurn(base, makeSkip(state, cfg));
        beginTurn(state);
        return { state, events };
      }

      case 'ADD_PLAYER': {
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events: [] };
        // A player joining mid-round starts their own round at hole 1.
        seatPlayer(state, cmd.player.id);
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.hole[cmd.playerId];
        delete state.strokes[cmd.playerId];
        delete state.points[cmd.playerId];
        delete state.results[cmd.playerId];
        delete state.turnStartPoints[cmd.playerId];
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (base.players.length > 0 && base.status === 'playing') beginTurn(state);
        return { state, events };
      }

      case 'END_MATCH': {
        events.push(...endMatchEarly(base, (id) => state.points[id] ?? 0));
        return { state, events };
      }

      case 'RESTART_LEG': {
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetLeg(state);
        beginTurn(state);
        return { state, events };
      }

      case 'THROW': {
        if (base.status !== 'playing' || base.turnEnded) return { state: prev, events: [] };

        const player = activePlayer(base);
        if (isDone(state, cfg, player.id)) return { state: prev, events: [] };

        const dart = cmd.throw;
        base.turn.push(dart);
        base.legDarts[player.id] = (base.legDarts[player.id] ?? 0) + 1;

        const hole = state.hole[player.id] ?? 1;
        const par = personalPar(cfg, player.id, hole);
        const strokes = (state.strokes[player.id] ?? 0) + 1;
        state.strokes[player.id] = strokes;

        const holed = dart.segment.ring !== 'MISS' && dart.segment.number === hole;
        // The hole is abandoned once one stroke over par has been spent on it.
        const overrun = !holed && strokes >= par + 1;
        let scored = 0;

        if (holed || overrun) {
          scored = stablefordPoints(par, strokes, holed);
          state.points[player.id] = (state.points[player.id] ?? 0) + scored;
          (state.results[player.id] ??= []).push({ hole, par, strokes, points: scored, holed });
          state.hole[player.id] = hole + 1;
          state.strokes[player.id] = 0;
          events.push({
            type: 'golf.hole',
            playerId: player.id,
            hole,
            strokes,
            par,
            points: scored,
            holed,
          });
        }

        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value: scored,
        });

        const roundOver = base.players.every((p) => isDone(state, cfg, p.id));
        if (roundOver) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.points[player.id] ?? 0) - (state.turnStartPoints[player.id] ?? 0),
            darts: base.turn.length,
            busted: false,
          });
          // Most points wins; ties fall to the earlier seat, as elsewhere.
          const winner = [...base.players].sort(
            (a, b) => (state.points[b.id] ?? 0) - (state.points[a.id] ?? 0),
          )[0];
          events.push(
            ...awardLeg(base, winner?.id ?? player.id, cfg.legsToWin, cfg.setsToWin, () => {
              resetLeg(state);
              beginTurn(state);
            }),
          );
          return { state, events };
        }

        // A player who has just played their last hole hands over immediately
        // rather than spending the rest of the turn on nothing.
        if (turnIsComplete(base) || isDone(state, cfg, player.id)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.points[player.id] ?? 0) - (state.turnStartPoints[player.id] ?? 0),
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
      const hole = state.hole[p.id] ?? 1;
      const done = hole > cfg.holes;
      const results = state.results[p.id] ?? [];
      const strokes = state.strokes[p.id] ?? 0;
      return {
        playerId: p.id,
        name: p.name,
        color: p.color,
        score: state.points[p.id] ?? 0,
        isActive: i === base.activeIndex && base.status === 'playing',
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: null,
        detail: {
          hole: done ? null : hole,
          holes: cfg.holes,
          strokes,
          par: done ? null : personalPar(cfg, p.id, hole),
          handicap: handicapOf(cfg, p.id),
          allowance: done ? 0 : strokeAllowance(handicapOf(cfg, p.id), cfg.holes, hole),
          results,
          done,
          /** Points that playing the rest of the round to par would add. */
          parPace: parPoints(cfg.holes - results.length),
        },
        stats: {
          average3: null,
          dartsThrown: base.legDarts[p.id] ?? 0,
        },
      };
    });

    // The hole number is the target for every dart left in the turn, so it
    // fills the same slots a checkout route would -- and lights up the board.
    const activeHole = active ? (state.hole[active.id] ?? 1) : 1;
    const hints =
      active && base.status === 'playing' && activeHole <= cfg.holes
        ? Array.from({ length: Math.max(0, dartsLeft) }, () => String(activeHole))
        : [];

    return {
      matchId,
      gameType: 'golf',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value, coords: t.coords })),
        // Points won this turn, not the board value of the darts -- a golf turn
        // scores when a hole is holed out, not when a dart happens to be a treble.
        total: active
          ? (state.points[active.id] ?? 0) - (state.turnStartPoints[active.id] ?? 0)
          : 0,
        dartsRemaining: dartsLeft,
        hints,
      },
      leg: base.leg,
      set: base.set,
      winnerId: base.winnerId,
      // Filled in by Match, which owns the command log.
      recent: [],
    };
  },
};
