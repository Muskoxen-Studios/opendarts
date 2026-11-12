import {
  MinefieldConfigSchema,
  MINEFIELD_INITIAL_MULTIPLIER,
  MINEFIELD_MULTIPLIER_STEP,
  minefieldHitPoints,
  MINEFIELD_TARGETS,
  segmentLabel,
  SEGMENT_ORDER,
  type DomainEvent,
  type MinefieldConfig,
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
  resetRound,
  clone,
  createBaseState,
  endMatchEarly,
  removePlayerFromBase,
  turnIsComplete,
} from './base.ts';
import type { BaseState, EngineResult, ForwardCommand, GameEngine } from './types.ts';

/** Shared numbers wear down; mines and blast zones clear after their configured lifetime. */
export interface MinefieldNumber {
  number: number;
  hp: number;
  multiplier: number;
  remaining: number;
}

export interface MinefieldState {
  base: BaseState;
  field: Record<number, MinefieldNumber>;
  hitPoints: number;
  zones: Record<number, { sources: number[]; remaining: number }>;
  turnValues: number[];
  scores: Record<string, number>;
  turnStartScore: Record<string, number>;
}

function seatPlayer(state: MinefieldState, playerId: string): void {
  state.scores[playerId] = 0;
  state.turnStartScore[playerId] = 0;
}

function resetLeg(state: MinefieldState, cfg: MinefieldConfig): void {
  state.hitPoints = cfg.hitPoints ?? minefieldHitPoints(state.base.players.length, cfg.hitPointsPerPlayer);
  state.zones = {};
  for (const p of state.base.players) seatPlayer(state, p.id);
  state.field = Object.fromEntries(MINEFIELD_TARGETS.map((number) => [
    number, { number, hp: state.hitPoints, multiplier: MINEFIELD_INITIAL_MULTIPLIER, remaining: cfg.mineLifetime },
  ]));
  if (state.hitPoints === 0) {
    for (const number of MINEFIELD_TARGETS) spreadBlast(state, number, cfg);
  }
}

/** Only scoring wedges have left/right neighbours; bull is never in the radius. */
function neighbours(number: number): number[] {
  const index = SEGMENT_ORDER.indexOf(number as (typeof SEGMENT_ORDER)[number]);
  if (index < 0) return [];
  return [SEGMENT_ORDER[(index + 19) % 20]!, SEGMENT_ORDER[(index + 1) % 20]!];
}

function spreadBlast(state: MinefieldState, number: number, cfg: MinefieldConfig): void {
  if (!cfg.blastRadius) return;
  for (const adjacent of neighbours(number)) {
    const zone = state.zones[adjacent] ??= { sources: [], remaining: cfg.mineLifetime };
    if (!zone.sources.includes(number)) zone.sources.push(number);
  }
}

/** Clearing a source also removes its radius, while overlapping sources keep theirs. */
function clearHazard(state: MinefieldState, number: number, exploded: boolean, cfg: MinefieldConfig): void {
  const cell = state.field[number]!;
  const wasMine = cell.hp === 0;
  cell.hp = state.hitPoints;
  cell.remaining = cfg.mineLifetime;
  if (exploded) cell.multiplier += MINEFIELD_MULTIPLIER_STEP;
  delete state.zones[number];
  if (wasMine) {
    for (const adjacent of neighbours(number)) {
      const zone = state.zones[adjacent];
      if (!zone) continue;
      zone.sources = zone.sources.filter((source) => source !== number);
      if (zone.sources.length === 0) delete state.zones[adjacent];
    }
  }
  // With zero HP, clearing immediately arms a fresh cycle.
  if (cell.hp === 0) spreadBlast(state, number, cfg);
}

/** Resolve the armed field before clearing anything, so chains cannot lose their sources. */
function explodeHazard(state: MinefieldState, number: number, cfg: MinefieldConfig): void {
  const affected = new Set([number]);
  for (const source of state.zones[number]?.sources ?? []) affected.add(source);
  for (const target of affected) {
    if (state.field[target]!.hp !== 0) continue;
    for (const adjacent of neighbours(target)) affected.add(adjacent);
  }
  for (const target of affected) clearHazard(state, target, true, cfg);
  // Restore zero-HP radii that another field's clearing may have removed.
  if (state.hitPoints === 0) {
    for (const target of affected) spreadBlast(state, target, cfg);
  }
}

function beginTurn(state: MinefieldState): void {
  state.turnValues = [];
  const p = state.base.players[state.base.activeIndex];
  if (!p) return;
  state.turnStartScore[p.id] = state.scores[p.id] ?? 0;
}

/** How well a player is doing -- higher is always better, since the target is a ceiling to reach. */
function progress(state: MinefieldState, playerId: string): number {
  return state.scores[playerId] ?? 0;
}

function checkRoundLimit(state: MinefieldState, cfg: MinefieldConfig): DomainEvent[] {
  return awardLegOnRoundLimit(state.base, cfg, (id) => progress(state, id), () => {
    resetLeg(state, cfg);
    beginTurn(state);
  });
}

export const minefieldEngine: GameEngine<MinefieldConfig, MinefieldState> = {
  id: 'minefield',

  parseConfig(raw) {
    return MinefieldConfigSchema.parse(raw);
  },

  createInitialState(players: Player[], cfg: MinefieldConfig): MinefieldState {
    const state: MinefieldState = {
      base: createBaseState(players),
      field: {},
      hitPoints: 0,
      zones: {},
      turnValues: [],
      scores: {},
      turnStartScore: {},
    };
    resetLeg(state, cfg);
    return state;
  },

  reduce(prev, cmd, cfg): EngineResult<MinefieldState> {
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
          advanceTurn(base);
          events.push(...checkRoundLimit(state, cfg));
          beginTurn(state);
          return { state, events };
        }
        const p = activePlayer(base);
        events.push({
          type: 'turn.completed',
          playerId: p.id,
          total: (state.scores[p.id] ?? 0) - (state.turnStartScore[p.id] ?? 0),
          darts: base.turn.length,
          busted: false,
        });
        advanceTurn(base);
        events.push(...checkRoundLimit(state, cfg));
        beginTurn(state);
        return { state, events };
      }

      case 'ADVANCE_TURN': {
        if (!base.turnEnded) return { state: prev, events: [] };
        advanceTurn(base);
        events.push(...checkRoundLimit(state, cfg));
        beginTurn(state);
        return { state, events };
      }

      case 'ADD_PLAYER': {
        if (!addPlayerToBase(base, cmd.player)) return { state: prev, events: [] };
        seatPlayer(state, cmd.player.id);
        events.push({ type: 'player.joined', playerId: cmd.player.id, name: cmd.player.name });
        return { state, events };
      }

      case 'REMOVE_PLAYER': {
        const removed = removePlayerFromBase(base, cmd.playerId);
        if (removed === null) return { state: prev, events: [] };
        delete state.scores[cmd.playerId];
        delete state.turnStartScore[cmd.playerId];
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (removed === prev.base.activeIndex && base.players.length > 0 && base.status === 'playing') {
          beginTurn(state);
        }
        return { state, events };
      }

      case 'END_MATCH': {
        events.push(...endMatchEarly(base, (id) => progress(state, id)));
        return { state, events };
      }

      case 'RESTART_LEG': {
        resetRound(base);
        base.activeIndex = base.legStartIndex;
        base.turn = [];
        base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetLeg(state, cfg);
        beginTurn(state);
        return { state, events };
      }

      case 'THROW': {
        if (base.status !== 'playing' || base.turnEnded) return { state: prev, events: [] };

        const player = activePlayer(base);
        const dart = cmd.throw;
        base.turn.push(dart);
        base.legDarts[player.id] = (base.legDarts[player.id] ?? 0) + 1;

        const number = state.field[dart.segment.number];
        const score = state.scores[player.id] ?? 0;
        let delta = dart.value;
        if (dart.segment.ring !== 'MISS' && number) {
          const mine = number.hp === 0;
          const zone = state.zones[number.number];
          if (!mine && !zone) {
            // The arming dart still scores normally, including doubles/triples.
            number.hp -= 1;
            if (number.hp === 0) spreadBlast(state, number.number, cfg);
          } else {
            const defused = cfg.defusal && (dart.segment.ring === 'DOUBLE' || dart.segment.ring === 'TRIPLE' || dart.segment.ring === 'BULL');
            if (defused) {
              events.push({ type: 'minefield.defused', playerId: player.id, number: number.number, segment: dart.segment, coords: dart.coords, rearmed: state.hitPoints === 0 });
              clearHazard(state, number.number, false, cfg);
            } else {
              if (mine && cfg.blastRadius) {
                // Negative-score protection avoids turning a mine into a free recovery.
                delta = score >= 0 || cfg.resetNegative ? -score : 0;
              } else {
                delta = -Math.round(number.number * number.multiplier);
              }
              events.push({ type: 'minefield.exploded', playerId: player.id, number: number.number, hazard: mine ? 'mine' : 'blast', value: delta, resetsScore: mine && cfg.blastRadius, segment: dart.segment, coords: dart.coords });
              const hazard = mine ? number : zone!;
              hazard.remaining -= 1;
              if (hazard.remaining === 0) {
                if (cfg.blastRadius) explodeHazard(state, number.number, cfg);
                else clearHazard(state, number.number, true, cfg);
              }
            }
          }
        }
        const next = score + delta;
        if (cfg.mode === 'gotcha' && cfg.exactFinish && next > cfg.targetScore) {
          state.scores[player.id] = state.turnStartScore[player.id] ?? 0;
          state.turnValues.push(0);
          events.push({ type: 'throw.recorded', playerId: player.id, dartIndex: base.turn.length - 1, value: 0 });
          events.push({ type: 'player.busted', playerId: player.id, reason: `overshot ${cfg.targetScore}` });
          events.push({ type: 'turn.completed', playerId: player.id, total: 0, darts: base.turn.length, busted: true });
          base.turnEnded = true;
          return { state, events };
        }
        state.turnValues.push(delta);
        state.scores[player.id] = next;
        events.push({
          type: 'throw.recorded',
          playerId: player.id,
          dartIndex: base.turn.length - 1,
          value: delta,
        });

        const won = cfg.mode === 'gotcha' && cfg.exactFinish ? next === cfg.targetScore : next >= cfg.targetScore;
        if (cfg.mode === 'gotcha' && !won && next > 0 && delta !== 0) {
          for (const opponent of base.players) {
            if (opponent.id === player.id || state.scores[opponent.id] !== next) continue;
            const to = cfg.knockback === 'zero' ? 0 : (state.turnStartScore[opponent.id] ?? 0);
            if (to === next) continue;
            state.scores[opponent.id] = to;
            events.push({ type: 'gotcha.knockback', byPlayerId: player.id, victimPlayerId: opponent.id, from: next, to });
          }
        }

        if (won) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
            darts: base.turn.length,
            busted: false,
          });
          events.push(
            ...awardLeg(base, player.id, cfg.legsToWin, cfg.setsToWin, () => {
              resetLeg(state, cfg);
              beginTurn(state);
            }),
          );
          return { state, events };
        }

        if (turnIsComplete(base)) {
          events.push({
            type: 'turn.completed',
            playerId: player.id,
            total: (state.scores[player.id] ?? 0) - (state.turnStartScore[player.id] ?? 0),
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
      return {
        playerId: p.id,
        name: p.name,
        color: p.color,
        score: state.scores[p.id] ?? 0,
        isActive: i === base.activeIndex && base.status === 'playing',
        legsWon: base.legsWon[p.id] ?? 0,
        setsWon: base.setsWon[p.id] ?? 0,
        checkout: null,
        detail: {
          targetScore: cfg.targetScore,
          mode: cfg.mode,
          blastRadius: cfg.blastRadius,
          resetNegative: cfg.resetNegative,
          defusal: cfg.defusal,
          mineLifetime: cfg.mineLifetime,
          hitPoints: state.hitPoints,
          field: MINEFIELD_TARGETS.map((number) => {
            const cell = state.field[number]!;
            const hazard = cell.hp === 0 ? 'mine' : state.zones[number] ? 'blast' : null;
            return {
              ...cell,
              hazard,
              hitsRemaining: hazard === 'mine' ? cell.remaining : (state.zones[number]?.remaining ?? 0),
              resetsScore: hazard === 'mine' && cfg.blastRadius,
              penalty: hazard === 'mine' && cfg.blastRadius ? null : Math.round(number * cell.multiplier),
              nextMultiplier: hazard ? cell.multiplier : null,
            };
          }),
        },
        stats: {
          average3: darts > 0 ? ((state.scores[p.id] ?? 0) / darts) * 3 : null,
          dartsThrown: darts,
        },
      };
    });

    return {
      matchId,
      gameType: 'minefield',
      status: base.status,
      players,
      activePlayerId: base.status === 'playing' ? (active?.id ?? null) : null,
      awaitingTakeout: base.turnEnded,
      turn: {
        throws: base.turn.map((t, i) => ({ id: t.id, label: segmentLabel(t.segment), value: state.turnValues[i] ?? 0, coords: t.coords })),
        total: active ? (state.scores[active.id] ?? 0) - (state.turnStartScore[active.id] ?? 0) : 0,
        dartsRemaining: dartsLeft,
        hints: [],
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
