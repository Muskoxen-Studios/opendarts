import { segmentValue, type DartThrow, type MatchCommand, type Player, type Segment } from '@darts/schema';
import type { Match } from './match.ts';

/**
 * Parse a dart label into a segment.
 * Accepts: T20, D16, S5, 20 (single), BULL, 25, MISS.
 */
export function seg(label: string): Segment {
  const s = label.trim().toUpperCase();
  if (s === 'MISS' || s === '0') return { number: 0, ring: 'MISS' };
  if (s === 'BULL' || s === 'D25' || s === '50') return { number: 25, ring: 'BULL' };
  if (s === '25' || s === 'SB' || s === 'OUTER_BULL') return { number: 25, ring: 'OUTER_BULL' };

  const m = /^([TDS]?)(\d{1,2})$/.exec(s);
  if (!m) throw new Error(`unparseable dart label: ${label}`);
  const number = Number(m[2]);
  if (number < 1 || number > 20) throw new Error(`segment out of range: ${label}`);
  switch (m[1]) {
    case 'T':
      return { number, ring: 'TRIPLE' };
    case 'D':
      return { number, ring: 'DOUBLE' };
    default:
      return { number, ring: 'SINGLE_OUTER' };
  }
}

let counter = 0;
export function resetDartIds(): void {
  counter = 0;
}

export function dart(label: string): DartThrow {
  const segment = seg(label);
  return {
    id: `t${counter++}`,
    ts: new Date(1700000000000 + counter * 1000).toISOString(),
    segment,
    value: segmentValue(segment),
    // Deliberately null: nothing in the engine may depend on coordinates.
    coords: null,
    source: 'simulator',
  };
}

export function throwCmd(label: string): MatchCommand {
  return { type: 'THROW', throw: dart(label) };
}

/**
 * Apply a sequence of dart labels to a match.
 *
 * A turn that ends is held for takeout (BaseState.turnEnded) rather than
 * handing over immediately -- real hardware waits for the darts to be pulled
 * out. Tests play like the simulator does: nothing physical to wait for, so
 * the handover is released the instant the turn ends.
 */
export function play(match: Match, ...labels: string[]): void {
  for (const l of labels) {
    match.apply(throwCmd(l));
    if (match.view.awaitingTakeout) match.apply({ type: 'ADVANCE_TURN' });
  }
}

export function players(...names: string[]): Player[] {
  return names.map((n, i) => ({ id: n.toLowerCase(), name: n, color: `#00000${i}` }));
}

export function scoreOf(match: Match, playerId: string): number {
  const p = match.view.players.find((x) => x.playerId === playerId);
  if (!p) throw new Error(`no such player: ${playerId}`);
  return p.score;
}
