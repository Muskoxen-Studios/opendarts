import {
  ConquestConfigSchema, SEGMENT_ORDER, segmentLabel, segmentMarks,
  type ConquestConfig, type ConquestTerritoryView, type DomainEvent, type Segment,
} from '@darts/schema';
import {
  activePlayer, advanceTurn, awardLeg, awardLegOnRoundLimit, clone,
  createBaseState, endMatchEarly, removePlayerFromBase, resetRound, turnIsComplete,
} from './base.ts';
import type { BaseState, GameEngine } from './types.ts';

/**
 * Conquest: 2/4/5/10/20 players, equally spaced outer homes in physical board order.
 * Three marks capture an adjacent field; any enemy hit resets an ordinary attack,
 * even remotely. Friendly hits defend. Misses/outer bull do nothing. Three darts per
 * turn, immediate captures, normal seating order, takeout hold between turns.
 * Split fields border their same-ring neighbours and the other half of their number.
 * Doubles belong to outer, trebles to inner; optional multipliers award 2/3 marks.
 * Home capture transfers all faction territory to the attacker, then eliminates
 * its players or recruits them according to the configured mode.
 * Optional foothold keeps defeated players throwing: reclaim the original home
 * without adjacency, independently, even from an allied faction. Fortified homes
 * need nine permanent marks, cannot be healed/sabotaged, and cannot be reclaimed.
 * Last independent faction wins immediately, even with comeback enabled. Early
 * endings/round caps prefer living leaders, then faction territory count. No late
 * joins: initial equal spacing is fixed. Removal dissolves a leader's faction.
 * Power of God: the uniquely last independent faction leader can arm one remote
 * instant enemy-capital capture with inner bull, bypassing fortified defenses.
 * All capital captures transfer the defeated faction's entire territory.
 * Misses and other fields preserve the charge; ties, catching up, defeat, a new
 * leg or spending it remove it. Allies and eliminated players cannot arm it.
 * Ranking uses faction territories, and ignores converted/eliminated seats.
 */
interface Conqueror { home: string; faction: string | null; godPower: boolean }
interface Territory extends Omit<ConquestTerritoryView, 'capturable'> {}
export interface ConquestState {
  base: BaseState;
  players: Record<string, Conqueror>;
  territories: Territory[];
}
const key = (number: number, lane: 'inner' | 'outer') => `${number}:${lane}`;

function resetLeg(state: ConquestState, cfg: ConquestConfig): void {
  state.players = {};
  state.territories = SEGMENT_ORDER.flatMap((number) =>
    (cfg.splitTerritories ? ['outer', 'inner'] as const : ['outer'] as const).map((lane) => ({
      id: key(number, lane), number, lane, ownerId: null, attackerId: null,
      marks: 0, required: 3, homeId: null,
    })),
  );
  state.base.players.forEach((p, i) => {
    // After roster departures, new legs spread the remaining seats as evenly as possible.
    const number = SEGMENT_ORDER[Math.floor(i * 20 / state.base.players.length)]!;
    const home = state.territories.find((t) => t.id === key(number, 'outer'))!;
    home.ownerId = p.id;
    home.homeId = p.id;
    home.required = cfg.fortifiedHomes ? 9 : 3;
    state.players[p.id] = { home: home.id, faction: p.id, godPower: false };
  });
}

function adjacent(state: ConquestState, target: Territory, faction: string): boolean {
  const index = SEGMENT_ORDER.findIndex((n) => n === target.number);
  const neighbours = [SEGMENT_ORDER[(index + 19) % 20], SEGMENT_ORDER[(index + 1) % 20]];
  return state.territories.some((t) => t.ownerId === faction && (
    (t.lane === target.lane && neighbours.includes(t.number as typeof SEGMENT_ORDER[number])) ||
    (t.number === target.number && t.lane !== target.lane)
  ));
}

function territoryFor(state: ConquestState, segment: Segment, cfg: ConquestConfig): Territory | undefined {
  if (segment.number < 1 || segment.number > 20 || segment.ring === 'MISS') return;
  const inner = cfg.splitTerritories && (segment.ring === 'SINGLE_INNER' || segment.ring === 'TRIPLE');
  return state.territories.find((t) => t.id === key(segment.number, inner ? 'inner' : 'outer'));
}
function comeback(state: ConquestState, id: string, cfg: ConquestConfig): boolean {
  return cfg.comebackFoothold && !cfg.fortifiedHomes && state.players[id]?.faction !== id;
}
function skip(state: ConquestState, id: string, cfg: ConquestConfig): boolean {
  return state.players[id]?.faction === null && !comeback(state, id, cfg);
}
function progress(state: ConquestState, id: string): number {
  if (state.players[id]?.faction !== id) return -1;
  return state.territories.filter((t) => t.ownerId === id).length;
}
/** Strictly lower territory count than every other independent faction. */
function uniqueLast(state: ConquestState): string | null {
  const leaders = state.base.players.filter((p) => state.players[p.id]?.faction === p.id);
  if (leaders.length < 2) return null;
  const ranked = leaders.map((p) => ({ id: p.id, score: progress(state, p.id) }))
    .sort((a, b) => a.score - b.score);
  return ranked[0]!.score < ranked[1]!.score ? ranked[0]!.id : null;
}
function reconcileGodPower(state: ConquestState): void {
  const eligible = uniqueLast(state);
  for (const [id, p] of Object.entries(state.players)) if (id !== eligible) p.godPower = false;
}
function enemyCapital(state: ConquestState, t: Territory, faction: string): boolean {
  return t.homeId !== null && t.homeId !== faction && t.ownerId === t.homeId &&
    state.players[t.homeId]?.faction === t.homeId;
}

function clearAttack(t: Territory): void { t.attackerId = null; t.marks = 0; }

function defeat(state: ConquestState, victim: string, attacker: string | null, cfg: ConquestConfig): void {
  const replacement = cfg.defeatMode === 'conversion' ? attacker : null;
  for (const p of Object.values(state.players)) if (p.faction === victim) p.faction = replacement;
  for (const t of state.territories) {
    if (t.ownerId === victim) t.ownerId = attacker;
    if (t.attackerId === victim) {
      if (replacement && t.ownerId !== replacement) t.attackerId = replacement;
      else if (!(cfg.fortifiedHomes && t.homeId)) clearAttack(t);
      else t.attackerId = null; // Permanent home damage survives the attacker's defeat.
    }
    if (t.ownerId === t.attackerId && !(cfg.fortifiedHomes && t.homeId)) clearAttack(t);
  }
}

function capture(state: ConquestState, t: Territory, faction: string, cfg: ConquestConfig, reclaim: boolean): void {
  const victim = t.homeId;
  t.ownerId = faction;
  clearAttack(t);
  if (reclaim) state.players[faction]!.faction = faction;
  if (victim && victim !== faction && state.players[victim]?.faction === victim) {
    defeat(state, victim, faction, cfg);
  }
  // Captured capitals cease being capitals; ordinary homes remain reclaimable.
  if (cfg.fortifiedHomes || !cfg.comebackFoothold) { t.homeId = null; t.required = 3; }
}

function hit(state: ConquestState, id: string, segment: Segment, cfg: ConquestConfig): number {
  const ps = state.players[id]!;
  if (segment.ring === 'BULL') {
    if (uniqueLast(state) === id) ps.godPower = true;
    return 0;
  }
  const t = territoryFor(state, segment, cfg);
  if (!t) return 0;
  if (ps.godPower && uniqueLast(state) === id && enemyCapital(state, t, id)) {
    ps.godPower = false;
    capture(state, t, id, cfg, false);
    return 1;
  }
  const reclaim = comeback(state, id, cfg) && t.id === ps.home;
  const faction = reclaim ? id : ps.faction;
  if (!faction) return 0;
  const fortified = cfg.fortifiedHomes && t.homeId !== null;
  if (t.ownerId === faction) {
    if (!fortified) clearAttack(t);
    return 0;
  }
  if (!fortified && t.attackerId !== faction) clearAttack(t);
  if (!reclaim && !adjacent(state, t, faction)) return 0;
  const marks = cfg.multipliers ? segmentMarks(segment) : 1;
  t.attackerId = faction;
  t.marks = Math.min(t.required, t.marks + marks);
  if (t.marks < t.required) return marks;
  capture(state, t, faction, cfg, reclaim);
  return marks;
}

export const conquestEngine: GameEngine<ConquestConfig, ConquestState> = {
  id: 'conquest',
  parseConfig: (raw) => ConquestConfigSchema.parse(raw),
  createInitialState(players, cfg) {
    if (players.length < 2 || 20 % players.length !== 0) {
      throw new Error('Conquest requires 2, 4, 5, 10 or 20 players for equally spaced homes.');
    }
    const state: ConquestState = { base: createBaseState(players), players: {}, territories: [] };
    resetLeg(state, cfg);
    return state;
  },
  reduce(prev, cmd, cfg) {
    const state = clone(prev);
    const base = state.base;
    const events: DomainEvent[] = [];
    const result = () => ({ state, events });
    const finishTurn = () => events.push({ type: 'turn.completed', playerId: activePlayer(base).id,
      total: 0, darts: base.turn.length, busted: false });
    const win = () => {
      const leaders = base.players.filter((p) => state.players[p.id]?.faction === p.id);
      if (leaders.length === 1) events.push(...awardLeg(base, leaders[0]!.id,
        cfg.legsToWin, cfg.setsToWin, () => resetLeg(state, cfg)));
    };
    const handover = () => {
      advanceTurn(base, (id) => skip(state, id, cfg));
      events.push(...awardLegOnRoundLimit(base, cfg, (id) => progress(state, id), () => resetLeg(state, cfg)));
    };
    switch (cmd.type) {
      case 'START':
        if (base.status !== 'idle') return { state: prev, events: [] };
        base.status = 'playing'; events.push({ type: 'match.started' }); return result();
      case 'ADD_PLAYER': return { state: prev, events: [] };
      case 'REMOVE_PLAYER': {
        if (base.status === 'finished' || !state.players[cmd.playerId]) return { state: prev, events: [] };
        const wasLeader = state.players[cmd.playerId]!.faction === cmd.playerId;
        if (wasLeader) defeat(state, cmd.playerId, null, { ...cfg, defeatMode: 'elimination' });
        removePlayerFromBase(base, cmd.playerId);
        delete state.players[cmd.playerId];
        reconcileGodPower(state);
        for (const t of state.territories) if (t.homeId === cmd.playerId) { t.homeId = null; t.required = 3; clearAttack(t); }
        events.push({ type: 'player.left', playerId: cmd.playerId });
        if (base.status === 'playing') {
          win();
          if (base.status === 'playing' && skip(state, activePlayer(base).id, cfg)) handover();
        }
        return result();
      }
      case 'END_MATCH': events.push(...endMatchEarly(base, (id) => progress(state, id))); return result();
      case 'RESTART_LEG':
        if (base.status !== 'playing') return { state: prev, events: [] };
        base.activeIndex = base.legStartIndex; base.turn = []; base.turnEnded = false;
        for (const p of base.players) base.legDarts[p.id] = 0;
        resetRound(base); resetLeg(state, cfg); return result();
      case 'NEXT_PLAYER':
        if (base.status !== 'playing') return { state: prev, events: [] };
        if (!base.turnEnded) finishTurn();
        handover(); return result();
      case 'ADVANCE_TURN':
        if (base.status !== 'playing' || !base.turnEnded) return { state: prev, events: [] };
        handover(); return result();
      case 'THROW': {
        if (base.status !== 'playing' || base.turnEnded) return { state: prev, events: [] };
        const id = activePlayer(base).id;
        base.turn.push(cmd.throw); base.legDarts[id] = (base.legDarts[id] ?? 0) + 1;
        reconcileGodPower(state);
        const value = hit(state, id, cmd.throw.segment, cfg);
        reconcileGodPower(state);
        events.push({ type: 'throw.recorded', playerId: id, dartIndex: base.turn.length - 1, value });
        const leaders = base.players.filter((p) => state.players[p.id]?.faction === p.id);
        if (leaders.length === 1) { finishTurn(); win(); }
        else if (turnIsComplete(base)) { finishTurn(); base.turnEnded = true; }
        return result();
      }
    }
  },
  view(state, cfg, matchId) {
    const b = state.base;
    const active = b.players[b.activeIndex];
    const faction = active ? state.players[active.id]?.faction : null;
    const eligible = b.status === 'playing' ? uniqueLast(state) : null;
    const powered = !!active && active.id === eligible && state.players[active.id]!.godPower;
    const territories: ConquestTerritoryView[] = state.territories.map((t) => ({ ...t,
      capturable: b.status === 'playing' && !b.turnEnded && !!active && (
        (comeback(state, active.id, cfg) && state.players[active.id]!.home === t.id) ||
        (!!faction && t.ownerId !== faction && adjacent(state, t, faction)) ||
        (powered && enemyCapital(state, t, active.id))
      ),
    }));
    return {
      matchId, gameType: 'conquest', status: b.status,
      players: b.players.map((p, i) => {
        const ps = state.players[p.id]!;
        return { playerId: p.id, name: p.name, color: p.color,
          score: ps.faction ? state.territories.filter((t) => t.ownerId === ps.faction).length : 0,
          isActive: i === b.activeIndex && b.status === 'playing',
          legsWon: b.legsWon[p.id] ?? 0, setsWon: b.setsWon[p.id] ?? 0, checkout: null,
          detail: { home: ps.home, factionId: ps.faction, eliminated: ps.faction === null,
            canComeback: comeback(state, p.id, cfg),
            canInvokeGod: p.id === eligible,
            godPower: p.id === eligible && ps.godPower, territories, ...cfg },
          stats: { average3: null, dartsThrown: b.legDarts[p.id] ?? 0 } };
      }),
      activePlayerId: b.status === 'playing' ? active?.id ?? null : null,
      awaitingTakeout: b.turnEnded,
      turn: { throws: b.turn.map((t) => ({ id: t.id, label: segmentLabel(t.segment), value: t.value, coords: t.coords })),
        total: 0, dartsRemaining: Math.max(0, 3 - b.turn.length),
        hints: active?.id === eligible && !powered && !b.turnEnded
          ? Array.from({ length: Math.max(0, 3 - b.turn.length) }, () => 'BULL') : [] },
      leg: b.leg, set: b.set, round: b.round, roundLimit: cfg.roundLimit, winnerId: b.winnerId, recent: [],
    };
  },
};
