import {
  KillerConfigSchema,
  segmentLabel,
  type DomainEvent,
  type KillerConfig,
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
 * Killer.
 *
 * Two phases. In `assign`, every player throws once for a number of their own:
 * the first dart landing on an unclaimed 1..20 in any ring claims it, and a
 * player who finds nothing in three darts is handed a random unclaimed number
 * so no one gets stuck. Once everyone has a number, play begins.
 *
 * In `play`, a player who is not yet a killer can only become one by hitting
 * their own double. Once a killer, hitting an opponent's double costs that
 * opponent a life; with `friendlyFire` on, hitting your own double again does
 * the same to you. A player at zero lives is eliminated and skipped for the
 * rest of the match. Last player standing wins.
 */

export interface KillerPlayerState {
  number: number | null;
  isKiller: boolean;
  lives: number;
  eliminated: boolean;
}

export interface KillerState {
  base: BaseState;
  phase: 'assign' | 'play';
  players: Record<string, KillerPlayerState>;
}

const NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);

function claimedNumbers(state: KillerState): Set<number> {
  return new Set(
    Object.values(state.players)
      .map((p) => p.number)
      .filter((n): n is number => n !== null),
  );
}

function randomUnclaimedNumber(state: KillerState): number | null {
  const claimed = claimedNumbers(state);
  const available = NUMBERS.filter((n) => !claimed.has(n));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)]!;
}

function seatPlayer(state: KillerState, playerId: string, cfg: KillerConfig): void {
  state.players[playerId] = {
    number: null,
    isKiller: false,
    lives: cfg.startingLives,
    eliminated: false,
  };
}

function resetLeg(state: KillerState, cfg: KillerConfig): void {
  state.phase = 'assign';
  for (const p of state.base.players) seatPlayer(state, p.id, cfg);
}

function isEliminated(state: KillerState, playerId: string): boolean {
  return state.players[playerId]?.eliminated ?? false;
}

function isUnassigned(state: KillerState, playerId: string): boolean {
  return state.players[playerId]?.number === null;
}

export const killerEngine: GameEngine<KillerConfig, KillerState> = {
  id: 'killer',

  parseConfig(raw) {
    return KillerConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: KillerConfig): KillerState {
    const state: KillerState = {
      base: createBaseState(players),
      phase: 'assign',
      players: {},
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<KillerState> {
    const state = clone(prev);
    const events: DomainEvent[] = [];
    const base = state.base;

    switch (cmd.type) {
      case 'START': {
        if (base.status !== 'idle') return { state: prev, events: [] };
        base.status = 'playing';
        events.push({ type: 'match.started' });
        return { state, events };
      }

      case 'NEXT_PLAYER': {
        if (base.status !== 'playing') return { state: prev, events: [] };
        if (base.turnEnded) {
          advanceTurn(base, (id) =>
            state.phase === 'assign' ? !isUnassigned(state, id) : isEliminated(state, id),
          );
          return { state, events };
        }
        const p = activePlayer(base);
        events.push({
          type: 'turn.completed',
          playerId: p.id,
          total: 0,
          darts: base.turn.length,
          busted: false,
        });
        advanceTurn(base, (id) =>
          state.phase === 'assign' ? !isUnassigned(state, id) : isEliminated(state, id),
        );
        return { state, events };
      }

      case 'ADVANCE_TURN': {
        if (!base.turnEnded) return { state: prev, events: [] };
        advanceTurn(base, (id) =>
          state.phase === 'assign' ? !isUnassigned(state, id) : isEliminated(state, id),
        );
        return { state, events };
      }

      case 'ADD_PLAYER': {
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events: [] };
        seatPlayer(state, cmd.player.id, cfg);
        if (state.phase === 'play') {
          // Latecomers skip the assignment dance and go straight in.
          const num = randomUnclaimedNumber(state);
          if (num !== null) {
            state.players[cmd.player.id]!.number = num;
            events.push({ type: 'killer.assigned', playerId: cmd.player.id, number: num, auto: true });
          }
        }
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.players[cmd.playerId];
        events.push({ type: 'player.left', playerId: cmd.playerId });
        return { state, events };
      }

      case 'END_MATCH': {
        events.push(
          ...endMatchEarly(base, (id) =>
            isEliminated(state, id) ? -1 : (state.players[id]?.lives ?? 0),
          ),
        );
        return { state, events };
      }

      case 'RESTART_LEG': {
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetLeg(state, cfg);
        return { state, events };
      }

      case 'THROW': {
        if (base.status !== 'playing' || base.turnEnded) return { state: prev, events: [] };

        const player = activePlayer(base);
        const dart = cmd.throw;
        base.turn.push(dart);
        base.legDarts[player.id] = (base.legDarts[player.id] ?? 0) + 1;

        if (state.phase === 'assign') {
          const ps = state.players[player.id]!;
          if (ps.number === null) {
            const num = dart.segment.number;
            const eligible =
              dart.segment.ring !== 'MISS' &&
              dart.segment.ring !== 'BULL' &&
              dart.segment.ring !== 'OUTER_BULL' &&
              num >= 1 &&
              num <= 20;
            if (eligible && !claimedNumbers(state).has(num)) {
              ps.number = num;
              events.push({ type: 'killer.assigned', playerId: player.id, number: num, auto: false });
            }
          }

          events.push({
            type: 'throw.recorded',
            playerId: player.id,
            dartIndex: base.turn.length - 1,
            value: 0,
          });

          if (ps.number !== null || turnIsComplete(base)) {
            if (ps.number === null) {
              const num = randomUnclaimedNumber(state);
              if (num !== null) {
                ps.number = num;
                events.push({ type: 'killer.assigned', playerId: player.id, number: num, auto: true });
              }
            }

            events.push({
              type: 'turn.completed',
              playerId: player.id,
              total: 0,
              darts: base.turn.length,
              busted: false,
            });

            const allAssigned = base.players.every((p) => !isUnassigned(state, p.id));
            if (allAssigned) state.phase = 'play';
            base.turnEnded = true;
          }

          return { state, events };
        }

        // phase === 'play'
        const ps = state.players[player.id]!;
        let value = 0;

        if (dart.segment.ring === 'DOUBLE' && dart.segment.number === ps.number) {
          if (!ps.isKiller) {
            ps.isKiller = true;
            events.push({ type: 'killer.becameKiller', playerId: player.id });
          } else if (cfg.friendlyFire) {
            ps.lives -= 1;
            value = 1;
            events.push({
              type: 'killer.hit',
              byPlayerId: player.id,
              victimPlayerId: player.id,
              livesLeft: ps.lives,
            });
            if (ps.lives <= 0) {
              ps.eliminated = true;
              events.push({ type: 'killer.eliminated', playerId: player.id });
            }
          }
        } else if (ps.isKiller && dart.segment.ring === 'DOUBLE') {
          const victim = base.players.find(
            (p) =>
              p.id !== player.id &&
              state.players[p.id]!.number === dart.segment.number &&
              !state.players[p.id]!.eliminated,
          );
          if (victim) {
            const vs = state.players[victim.id]!;
            vs.lives -= 1;
            value = 1;
            events.push({
              type: 'killer.hit',
              byPlayerId: player.id,
              victimPlayerId: victim.id,
              livesLeft: vs.lives,
            });
            if (vs.lives <= 0) {
              vs.eliminated = true;
              events.push({ type: 'killer.eliminated', playerId: victim.id });
            }
          }
        }

        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value,
        });

        const remaining = base.players.filter((p) => !state.players[p.id]!.eliminated);
        if (remaining.length <= 1) {
          const winner = remaining[0] ?? player;
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: 0,
            darts: base.turn.length,
            busted: false,
          });
          events.push(
            ...awardLeg(base, winner.id, cfg.legsToWin, cfg.setsToWin, () => {
              resetLeg(state, cfg);
            }),
          );
          return { state, events };
        }

        if (turnIsComplete(base)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: 0,
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
      const darts = base.legDarts[p.id] ?? 0;
      const ps = state.players[p.id];
      return {
        playerId: p.id,
        name: p.name,
        color: p.color,
        score: ps?.lives ?? 0,
        isActive: i === base.activeIndex && base.status === 'playing',
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: null,
        detail: {
          phase: state.phase,
          number: ps?.number ?? null,
          isKiller: ps?.isKiller ?? false,
          lives: ps?.lives ?? 0,
          startingLives: cfg.startingLives,
          eliminated: ps?.eliminated ?? false,
        },
        stats: {
          average3: null,
          dartsThrown: darts,
        },
      };
    });

    const activePs = active ? state.players[active.id] : undefined;
    const hints =
      active && base.status === 'playing' && state.phase === 'play' && activePs && !activePs.isKiller
        ? Array.from({ length: Math.max(0, dartsLeft) }, () => `D${activePs.number}`)
        : [];

    return {
      matchId,
      gameType: 'killer',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value, coords: t.coords })),
        total: 0,
        dartsRemaining: dartsLeft,
        hints,
      },
      leg: base.leg,
      set: base.set,
      winnerId: base.winnerId,
      recent: [],
    };
  },
};
