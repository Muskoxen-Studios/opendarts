import type { DomainEvent, Player } from '@darts/schema';
import type { BaseState } from './types.ts';

export const DARTS_PER_TURN = 3;

export function createBaseState(players: Player[]): BaseState {
  const zero: Record<string, number> = {};
  for (const p of players) zero[p.id] = 0;
  return {
    players,
    activeIndex: 0,
    status: 'idle',
    leg: 1,
    set: 1,
    legsWon: { ...zero },
    setsWon: { ...zero },
    turn: [],
    winnerId: null,
    legDarts: { ...zero },
    legStartIndex: 0,
    round: 1,
    roundTurns: [],
    turnEnded: false,
  };
}

export function activePlayer(base: BaseState): Player {
  const p = base.players[base.activeIndex];
  if (!p) throw new Error(`no player at index ${base.activeIndex}`);
  return p;
}

export function playerById(base: BaseState, id: string): Player | undefined {
  return base.players.find((p) => p.id === id);
}

/** Start the round counter over, as a new leg does. */
export function resetRound(base: BaseState): void {
  base.round = 1;
  base.roundTurns = [];
}

/**
 * Record that the active player has had their turn, and roll the round counter
 * once everyone still in the leg has had theirs.
 *
 * Counting players rather than watching `activeIndex` wrap past `legStartIndex`
 * is what makes this correct when the rotation skips people -- X01 played to
 * finishing places, or Killer once someone is eliminated, would otherwise never
 * come back round to the player the leg started with.
 */
function countTurnForRound(base: BaseState, skip?: (playerId: string) => boolean): void {
  const current = base.players[base.activeIndex];
  if (current && !base.roundTurns.includes(current.id)) base.roundTurns.push(current.id);

  const stillIn = base.players.filter((p) => !skip || !skip(p.id));
  if (stillIn.every((p) => base.roundTurns.includes(p.id))) {
    base.round += 1;
    base.roundTurns = [];
  }
}

/**
 * Clear the current turn and hand over to the next player.
 *
 * `skip` lets a game exclude players who are out of the current leg -- X01
 * played to finishing places keeps going after someone checks out, and their
 * turn must not come round again.
 */
export function advanceTurn(base: BaseState, skip?: (playerId: string) => boolean): void {
  base.turn = [];
  base.turnEnded = false;
  const count = base.players.length;
  if (count === 0) return;

  countTurnForRound(base, skip);

  for (let step = 1; step <= count; step++) {
    const index = (base.activeIndex + step) % count;
    const player = base.players[index];
    if (!player) continue;
    if (!skip || !skip(player.id)) {
      base.activeIndex = index;
      return;
    }
  }
  // Everyone is skipped; leave the rotation alone rather than looping forever.
  base.activeIndex = (base.activeIndex + 1) % count;
}

export function turnIsComplete(base: BaseState): boolean {
  return base.turn.length >= DARTS_PER_TURN;
}

/**
 * Record a leg win, roll up into sets, and decide whether the match is over.
 * Returns the events produced. Mutates `base`.
 */
export function awardLeg(
  base: BaseState,
  playerId: string,
  legsToWin: number,
  setsToWin: number,
  onNewLeg: () => void,
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const darts = base.legDarts[playerId] ?? 0;
  base.legsWon[playerId] = (base.legsWon[playerId] ?? 0) + 1;
  events.push({ type: 'leg.won', playerId, darts });

  if ((base.legsWon[playerId] ?? 0) >= legsToWin) {
    base.setsWon[playerId] = (base.setsWon[playerId] ?? 0) + 1;
    events.push({ type: 'set.won', playerId });

    if ((base.setsWon[playerId] ?? 0) >= setsToWin) {
      base.status = 'finished';
      base.winnerId = playerId;
      base.turn = [];
      base.turnEnded = false;
      events.push({ type: 'match.won', playerId });
      return events;
    }

    // New set: legs reset, leg counter resets.
    for (const p of base.players) base.legsWon[p.id] = 0;
    base.set += 1;
    base.leg = 1;
  } else {
    base.leg += 1;
  }

  // Start the next leg with the next player in rotation.
  base.legStartIndex = (base.legStartIndex + 1) % base.players.length;
  base.activeIndex = base.legStartIndex;
  base.turn = [];
  base.turnEnded = false;
  for (const p of base.players) base.legDarts[p.id] = 0;
  resetRound(base);
  onNewLeg();
  return events;
}

/**
 * Stop a match early and hand it to whoever is closest to winning.
 *
 * Sets and legs already banked outrank in-leg progress: a player 2-0 up in legs
 * is closer to the match than someone merely ahead in the current one. Within
 * that, `progress` is the engine's own measure of how well a player is doing in
 * the current leg -- higher is better, so a game where a low number is good
 * (X01) simply negates it.
 *
 * Returns the events produced, or an empty array when the match is not running.
 */
export function endMatchEarly(
  base: BaseState,
  progress: (playerId: string) => number,
): DomainEvent[] {
  if (base.status !== 'playing') return [];
  if (base.players.length === 0) return [];

  const ranked = [...base.players].sort((a, b) => {
    const sets = (base.setsWon[b.id] ?? 0) - (base.setsWon[a.id] ?? 0);
    if (sets !== 0) return sets;
    const legs = (base.legsWon[b.id] ?? 0) - (base.legsWon[a.id] ?? 0);
    if (legs !== 0) return legs;
    return progress(b.id) - progress(a.id);
  });

  // Ties fall to the first player in the sorted order, which is the seat order
  // the match started with. Someone has to be given it, and seat order is at
  // least stable across a refold of the log.
  const winner = ranked[0];
  if (!winner) return [];

  base.status = 'finished';
  base.winnerId = winner.id;
  base.turn = [];
  base.turnEnded = false;
  return [
    { type: 'match.conceded', playerId: winner.id },
    { type: 'match.won', playerId: winner.id },
  ];
}

/**
 * End the leg when the configured round limit has been passed, awarding it to
 * whoever is closest to winning.
 *
 * `progress` is the same comparator the engine already hands `endMatchEarly` --
 * higher is better -- so a game only has to decide once what "ahead" means.
 * Returns the events produced, or an empty array when there is no limit, it has
 * not been reached, or the match is not running.
 *
 * Call this after `advanceTurn`, which is what moves `base.round`: the limit is
 * a cap on the leg, not the match, so `legsToWin` and `setsToWin` still decide
 * when the match itself is over.
 */
export function awardLegOnRoundLimit(
  base: BaseState,
  limits: { roundLimit: number | null; legsToWin: number; setsToWin: number },
  progress: (playerId: string) => number,
  onNewLeg: () => void,
): DomainEvent[] {
  if (limits.roundLimit === null) return [];
  if (base.status !== 'playing') return [];
  if (base.round <= limits.roundLimit) return [];
  if (base.players.length === 0) return [];

  // Ties fall to seat order, same rule and same reasoning as endMatchEarly.
  const leader = [...base.players].sort((a, b) => progress(b.id) - progress(a.id))[0];
  if (!leader) return [];

  return awardLeg(base, leader.id, limits.legsToWin, limits.setsToWin, onNewLeg);
}

/** Deep clone that is safe for our plain-object state. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Add a player to a match already in progress.
 *
 * Returns false if the player is already in the match. The caller is
 * responsible for seeding any game-specific state (a starting score, cricket
 * marks, and so on).
 */
export function addPlayerToBase(base: BaseState, player: Player): boolean {
  if (base.players.some((p) => p.id === player.id)) return false;
  base.players.push(player);
  base.legsWon[player.id] ??= 0;
  base.setsWon[player.id] ??= 0;
  base.legDarts[player.id] ??= 0;
  return true;
}

/**
 * Remove a player from a match in progress.
 *
 * Returns the index they occupied, or null if they were not playing. Turn
 * order is repaired so that removing someone who is not currently throwing
 * does not skip or repeat anyone -- and removing the player who *is* throwing
 * ends their turn cleanly rather than leaving darts attributed to nobody.
 */
export function removePlayerFromBase(base: BaseState, playerId: string): number | null {
  const index = base.players.findIndex((p) => p.id === playerId);
  if (index < 0) return null;

  const wasActive = index === base.activeIndex;
  base.players.splice(index, 1);
  delete base.legsWon[playerId];
  delete base.setsWon[playerId];
  delete base.legDarts[playerId];
  base.roundTurns = base.roundTurns.filter((id) => id !== playerId);

  if (base.players.length === 0) {
    base.activeIndex = 0;
    base.legStartIndex = 0;
    base.turn = [];
    base.turnEnded = false;
    resetRound(base);
    base.status = 'finished';
    return index;
  }

  if (wasActive) {
    base.turn = [];
    base.turnEnded = false;
  } else if (index < base.activeIndex) {
    base.activeIndex -= 1;
  }
  if (index < base.legStartIndex) base.legStartIndex -= 1;

  base.activeIndex %= base.players.length;
  base.legStartIndex %= base.players.length;
  return index;
}
