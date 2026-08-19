import {
  X01ConfigSchema,
  isDouble,
  isMaster,
  segmentLabel,
  type DomainEvent,
  type InOutMode,
  type MatchView,
  type Player,
  type PlayerView,
  type Segment,
  type X01Config,
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
import { suggestCheckout } from './checkout.ts';
import type { BaseState, EngineResult, ForwardCommand, GameEngine } from './types.ts';

export interface X01State {
  base: BaseState;
  scores: Record<string, number>;
  /** Whether the player has satisfied the in-rule (always true for straight-in). */
  startedIn: Record<string, boolean>;
  /** Score at the start of the active turn, restored on a bust. */
  turnStartScore: Record<string, number>;
  /** In-status at the start of the active turn, also restored on a bust. */
  turnStartedIn: Record<string, boolean>;
  /**
   * Player ids in the order they checked out this leg.
   *
   * Only meaningful when `legEnd` is 'all-but-one', where play continues after
   * the first checkout so everyone gets a finishing place.
   */
  places: string[];
}

export interface ResolvedX01Rules {
  startScore: number;
  inMode: InOutMode;
  outMode: InOutMode;
}

/**
 * Per-player rules. This is the handicap mechanism: a player may have their own
 * starting score and their own in/out rules, so 501 double-out can be played
 * against 301 straight-out in the same leg.
 */
export function rulesFor(cfg: X01Config, playerId: string): ResolvedX01Rules {
  const o = cfg.perPlayer[playerId] ?? {};
  return {
    startScore: o.startScore ?? cfg.startScore,
    inMode: o.inMode ?? cfg.inMode,
    outMode: o.outMode ?? cfg.outMode,
  };
}

function satisfiesMode(segment: Segment, mode: InOutMode): boolean {
  if (mode === 'straight') return true;
  if (mode === 'master') return isMaster(segment);
  return isDouble(segment);
}

/** Players already checked out this leg do not get another turn. */
function makeSkip(state: X01State, cfg: X01Config): ((playerId: string) => boolean) | undefined {
  if (cfg.legEnd !== 'all-but-one') return undefined;
  return (playerId: string) => state.places.includes(playerId);
}

function beginTurn(state: X01State): void {
  const p = activePlayer(state.base);
  state.turnStartScore[p.id] = state.scores[p.id] ?? 0;
  state.turnStartedIn[p.id] = state.startedIn[p.id] ?? false;
}

function resetLegScores(state: X01State, cfg: X01Config): void {
  state.places = [];
  for (const p of state.base.players) {
    const rules = rulesFor(cfg, p.id);
    state.scores[p.id] = rules.startScore;
    state.startedIn[p.id] = rules.inMode === 'straight';
  }
  beginTurn(state);
}

export const x01Engine: GameEngine<X01Config, X01State> = {
  id: 'x01',

  parseConfig(raw) {
    return X01ConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: X01Config): X01State {
    const state: X01State = {
      base: createBaseState(players),
      scores: {},
      startedIn: {},
      turnStartScore: {},
      turnStartedIn: {},
      places: [],
    };
    resetLegScores(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<X01State> {
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
        const p = activePlayer(base);
        events.push({
          type: 'turn.completed',
          playerId: p.id,
          total: (state.turnStartScore[p.id] ?? 0) - (state.scores[p.id] ?? 0),
          darts: base.turn.length,
          busted: false,
        });
        advanceTurn(base, makeSkip(state, cfg));
        beginTurn(state);
        return { state, events };
      }

      case 'ADD_PLAYER': {
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events: [] };
        // A player joining mid-leg starts on their own full score.
        const rules = rulesFor(cfg, cmd.player.id);
        state.scores[cmd.player.id] = rules.startScore;
        state.startedIn[cmd.player.id] = rules.inMode === 'straight';
        state.turnStartScore[cmd.player.id] = rules.startScore;
        state.turnStartedIn[cmd.player.id] = rules.inMode === 'straight';
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.scores[cmd.playerId];
        delete state.startedIn[cmd.playerId];
        delete state.turnStartScore[cmd.playerId];
        delete state.turnStartedIn[cmd.playerId];
        state.places = state.places.filter((id) => id !== cmd.playerId);
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (base.players.length > 0 && base.status === 'playing') beginTurn(state);
        return { state, events };
      }

      case 'END_MATCH': {
        // Closest to winning is the lowest remaining score -- except that
        // anyone who has already checked out this leg is ahead of everyone
        // still throwing, in the order they finished.
        events.push(
          ...endMatchEarly(base, (id) => {
            const place = state.places.indexOf(id);
            if (place >= 0) return 1_000_000 - place;
            return -(state.scores[id] ?? 0);
          }),
        );
        return { state, events };
      }

      case 'RESTART_LEG': {
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetLegScores(state, cfg);
        return { state, events };
      }

      case 'THROW': {
        if (base.status !== 'playing') return { state: prev, events: [] };

        const player = activePlayer(base);
        const rules = rulesFor(cfg, player.id);
        const dart = cmd.throw;

        base.turn.push(dart);
        base.legDarts[player.id] = (base.legDarts[player.id] ?? 0) + 1;

        let busted = false;
        let bustReason = '';
        let legWon = false;
        let counted = 0;

        const isIn = state.startedIn[player.id] ?? false;
        if (!isIn && !satisfiesMode(dart.segment, rules.inMode)) {
          // Not in yet: the dart scores nothing at all.
          events.push({
            type: 'throw.recorded',
            playerId: player.id,
            dartIndex: base.turn.length - 1,
            value: 0,
          });
        } else {
          if (!isIn) state.startedIn[player.id] = true;

          const score = state.scores[player.id] ?? 0;
          const next = score - dart.value;

          if (next < 0) {
            busted = true;
            bustReason = 'score below zero';
          } else if (next === 0) {
            if (satisfiesMode(dart.segment, rules.outMode)) {
              legWon = true;
              counted = dart.value;
              state.scores[player.id] = 0;
            } else {
              busted = true;
              bustReason = `finish requires ${rules.outMode}`;
            }
          } else if (next === 1 && rules.outMode !== 'straight') {
            busted = true;
            bustReason = 'cannot finish from 1';
          } else {
            counted = dart.value;
            state.scores[player.id] = next;
          }

          events.push({
            type: 'throw.recorded',
            playerId: player.id,
            dartIndex: base.turn.length - 1,
            value: counted,
          });
        }

        if (busted) {
          // Revert everything to the state at the start of this turn.
          state.scores[player.id] = state.turnStartScore[player.id] ?? 0;
          state.startedIn[player.id] = state.turnStartedIn[player.id] ?? false;
          events.push({ type: 'player.busted', playerId: player.id, reason: bustReason });
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: 0,
            darts: base.turn.length,
            busted: true,
          });
          advanceTurn(base, makeSkip(state, cfg));
          beginTurn(state);
          return { state, events };
        }

        if (legWon) {
          const darts = base.legDarts[player.id] ?? 0;
          state.places.push(player.id);
          events.push({
            type: 'x01.checkout',
            playerId: player.id,
            score: rules.startScore,
            darts,
          });
          events.push({
            type: 'x01.placed',
            playerId: player.id,
            place: state.places.length,
          });
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.turnStartScore[player.id] ?? 0) - 0,
            darts: base.turn.length,
            busted: false,
          });

          // Playing to places: carry on until only one player is left in.
          const stillIn = base.players.filter((p) => !state.places.includes(p.id));
          if (cfg.legEnd === 'all-but-one' && stillIn.length > 1) {
            advanceTurn(base, makeSkip(state, cfg));
            beginTurn(state);
            return { state, events };
          }

          // The leg belongs to whoever checked out first.
          const legWinner = state.places[0] ?? player.id;
          events.push(
            ...awardLeg(base, legWinner, cfg.legsToWin, cfg.setsToWin, () => {
              resetLegScores(state, cfg);
            }),
          );
          return { state, events };
        }

        if (turnIsComplete(base)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.turnStartScore[player.id] ?? 0) - (state.scores[player.id] ?? 0),
            darts: base.turn.length,
            busted: false,
          });
          advanceTurn(base, makeSkip(state, cfg));
          beginTurn(state);
        }

        return { state, events };
      }
    }
  },

  view(state, cfg, matchId): MatchView {
    const base = state.base;
    const active = base.players[base.activeIndex];
    const dartsLeft = 3 - base.turn.length;

    // The checkout route for whoever is at the oche, recomputed every dart.
    // Empty when the score is not checkable with the darts left.
    const activeRules = active ? rulesFor(cfg, active.id) : null;
    const hints =
      active && activeRules && base.status === 'playing'
        ? (suggestCheckout(state.scores[active.id] ?? 0, dartsLeft, activeRules.outMode) ?? [])
        : [];

    const players: PlayerView[] = base.players.map((p, i) => {
      const rules = rulesFor(cfg, p.id);
      const score = state.scores[p.id] ?? rules.startScore;
      const darts = base.legDarts[p.id] ?? 0;
      const scored = rules.startScore - score;
      const isActive = i === base.activeIndex && base.status === 'playing';
      return {
        playerId: p.id,
        name: p.name,
        color: p.color,
        score,
        isActive,
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: isActive ? suggestCheckout(score, dartsLeft, rules.outMode) : null,
        detail: {
          startScore: rules.startScore,
          inMode: rules.inMode,
          outMode: rules.outMode,
          startedIn: state.startedIn[p.id] ?? false,
          // 1-based finishing place, or null while still playing.
          place: state.places.indexOf(p.id) >= 0 ? state.places.indexOf(p.id) + 1 : null,
        },
        stats: {
          average3: darts > 0 ? (scored / darts) * 3 : null,
          dartsThrown: darts,
        },
      };
    });

    return {
      matchId,
      gameType: 'x01',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value })),
        total: base.turn.reduce((a, t) => a + t.value, 0),
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
