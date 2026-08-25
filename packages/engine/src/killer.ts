import {
  KillerConfigSchema,
  segmentLabel,
  segmentMarks,
  type Segment,
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
  awardLegOnRoundLimit,
  clone,
  createBaseState,
  endMatchEarly,
  removePlayerFromBase,
  resetRound,
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
 * In `play`, a dart is counted in *hits* -- its multiplier, so a single is one
 * hit and a triple is three. Three hits on your own number, in any ring and
 * across as many darts as it takes, make you a killer. Once a killer, every hit
 * on an opponent's number costs them a third of a life, so a triple takes a
 * whole one; with `friendlyFire` on, hits on your own number do the same to
 * you -- including the hits left over from the very dart that crowned you.
 * A player at zero lives is eliminated and skipped for the rest of the match.
 * Last player standing wins.
 *
 * Lives are held in thirds so that every fold of the command log is integer
 * arithmetic; only the view divides back into hearts.
 */

export interface KillerPlayerState {
  number: number | null;
  isKiller: boolean;
  /** Hits on own number so far, capped at `HITS_TO_KILL`. */
  ownHits: number;
  /** Lives * 3. */
  livesThirds: number;
  eliminated: boolean;
}

export interface KillerState {
  base: BaseState;
  phase: 'assign' | 'play';
  players: Record<string, KillerPlayerState>;
}

const NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);

/** Hits on your own number needed to become a killer. */
const HITS_TO_KILL = 3;
/** One hit off an opponent is a third of a life. */
const THIRDS_PER_LIFE = 3;

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
    ownHits: 0,
    livesThirds: (cfg.handicaps[playerId] ?? cfg.startingLives) * THIRDS_PER_LIFE,
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

/**
 * How well a player is doing this leg -- higher is better -- for both END_MATCH
 * and the round limit. Lives left, with anyone eliminated ranked below everyone
 * still standing.
 */
function progress(state: KillerState, playerId: string): number {
  return isEliminated(state, playerId) ? -1 : (state.players[playerId]?.livesThirds ?? 0);
}

/**
 * How many hits a dart is worth *on a player's number* -- its multiplier, or
 * zero for anything that cannot be someone's number (a miss or either bull).
 */
function hitsOn(segment: Segment): number {
  if (segment.number < 1 || segment.number > 20) return 0;
  if (segment.ring === 'MISS' || segment.ring === 'BULL' || segment.ring === 'OUTER_BULL') return 0;
  return segmentMarks(segment);
}

/**
 * Take `hits` thirds of a life off a player, eliminating them at zero. Returns
 * the events so the caller can splice them into its own stream in order.
 */
function damage(state: KillerState, byPlayerId: string, victimId: string, hits: number): DomainEvent[] {
  const vs = state.players[victimId]!;
  vs.livesThirds = Math.max(0, vs.livesThirds - hits);
  const events: DomainEvent[] = [
    { type: 'killer.hit', byPlayerId, victimPlayerId: victimId, hits, livesLeftThirds: vs.livesThirds },
  ];
  if (vs.livesThirds <= 0 && !vs.eliminated) {
    vs.eliminated = true;
    events.push({ type: 'killer.eliminated', playerId: victimId });
  }
  return events;
}

/**
 * Stop the leg if the configured round limit has just been passed. Called after
 * every handover, since `advanceTurn` is what moves the round on.
 */
function checkRoundLimit(state: KillerState, cfg: KillerConfig): DomainEvent[] {
  return awardLegOnRoundLimit(
    state.base,
    cfg,
    (id) => progress(state, id),
    () => resetLeg(state, cfg),
  );
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
          events.push(...checkRoundLimit(state, cfg));
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
        events.push(...checkRoundLimit(state, cfg));
        return { state, events };
      }

      case 'ADVANCE_TURN': {
        if (!base.turnEnded) return { state: prev, events: [] };
        advanceTurn(base, (id) =>
          state.phase === 'assign' ? !isUnassigned(state, id) : isEliminated(state, id),
        );
        events.push(...checkRoundLimit(state, cfg));
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
        events.push(...endMatchEarly(base, (id) => progress(state, id)));
        return { state, events };
      }

      case 'RESTART_LEG': {
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetRound(base);
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
        let hits = hitsOn(dart.segment);
        let value = 0;

        if (hits > 0 && dart.segment.number === ps.number) {
          if (!ps.isKiller) {
            // Hits go into becoming a killer first; whatever is left over from
            // the dart that crowns you counts as hitting your own number.
            const spent = Math.min(hits, HITS_TO_KILL - ps.ownHits);
            ps.ownHits += spent;
            hits -= spent;
            if (ps.ownHits >= HITS_TO_KILL) {
              ps.isKiller = true;
              events.push({ type: 'killer.becameKiller', playerId: player.id });
            }
          }
          if (hits > 0 && cfg.friendlyFire) {
            value = hits;
            events.push(...damage(state, player.id, player.id, hits));
          }
        } else if (hits > 0 && ps.isKiller) {
          const victim = base.players.find(
            (p) =>
              p.id !== player.id &&
              state.players[p.id]!.number === dart.segment.number &&
              !state.players[p.id]!.eliminated,
          );
          if (victim) {
            value = hits;
            events.push(...damage(state, player.id, victim.id, hits));
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
        score: (ps?.livesThirds ?? 0) / THIRDS_PER_LIFE,
        isActive: i === base.activeIndex && base.status === 'playing',
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: null,
        detail: {
          phase: state.phase,
          number: ps?.number ?? null,
          isKiller: ps?.isKiller ?? false,
          lives: (ps?.livesThirds ?? 0) / THIRDS_PER_LIFE,
          livesThirds: ps?.livesThirds ?? 0,
          startingLives: cfg.handicaps[p.id] ?? cfg.startingLives,
          ownHits: ps?.ownHits ?? 0,
          hitsToKill: HITS_TO_KILL,
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
        ? Array.from({ length: Math.max(0, dartsLeft) }, () => `S${activePs.number}`)
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
      round: base.round,
      roundLimit: cfg.roundLimit,
      winnerId: base.winnerId,
      recent: [],
    };
  },
};
