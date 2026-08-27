import type { DeepReadonly } from 'vue';
import type { MatchView } from '@darts/schema';

/**
 * The store is exposed through Vue's readonly() wrapper so components cannot
 * mutate match state directly -- it is server-authoritative. That makes every
 * view these helpers touch deeply readonly.
 */
export type View = DeepReadonly<MatchView>;
export type Player = View['players'][number];

/**
 * `detail` is an untyped bag by design -- it is whatever the engine for this
 * game type chose to publish, and the frontend deliberately does not import the
 * engine. These extractors are the one place the casts live, and they default
 * every field so a view from another game type cannot throw.
 */
export function killer(player: Player) {
  const d = player.detail;
  return {
    phase: (d.phase as 'assign' | 'play' | undefined) ?? 'assign',
    number: (d.number as number | null | undefined) ?? null,
    isKiller: (d.isKiller as boolean | undefined) ?? false,
    lives: (d.lives as number | undefined) ?? 0,
    livesThirds: (d.livesThirds as number | undefined) ?? 0,
    startingLives: (d.startingLives as number | undefined) ?? 0,
    ownHits: (d.ownHits as number | undefined) ?? 0,
    hitsToKill: (d.hitsToKill as number | undefined) ?? 3,
    eliminated: (d.eliminated as boolean | undefined) ?? false,
  };
}

export function gotcha(player: Player) {
  const d = player.detail;
  return {
    target: (d.target as number | undefined) ?? 0,
    remaining: (d.remaining as number | undefined) ?? 0,
    knockback: (d.knockback as 'zero' | 'previousTurn' | undefined) ?? 'zero',
  };
}

/**
 * How much of heart `i` (1-based) is still filled, as a CSS width. Damage comes
 * in thirds of a life, so the heart taking it is drawn partly eaten rather than
 * rounded away -- losing two thirds has to look different from losing one.
 */
export function heartFill(player: Player, i: number): string {
  const thirds = Math.min(3, Math.max(0, killer(player).livesThirds - (i - 1) * 3));
  return `${(thirds / 3) * 100}%`;
}

/** Finishing place in a leg played to places, or null while still in. */
export function placeOf(player: Player): number | null {
  return (player.detail.place as number | null) ?? null;
}

/**
 * Out of the running for the rest of the leg -- either finished (X01 played
 * to places) or eliminated (Killer). Drives the same dimmed styling either
 * way, so "who's still in it" reads at a glance in the strip.
 */
export function isOut(player: Player, gameType: View['gameType']): boolean {
  if (placeOf(player) !== null) return true;
  return gameType === 'killer' && killer(player).eliminated;
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
export function ordinal(place: number): string {
  return ORDINALS[place - 1] ?? `${place}th`;
}
