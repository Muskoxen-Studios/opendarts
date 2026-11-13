import { isDouble, isMaster, segmentLabel, type InOutMode, type Segment } from '@darts/schema';
import type { BaseState } from './types.ts';

/** Seeded, replay-safe randomness: the seed is part of the persisted config. */
export function trainingRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x100000000; };
}
export function legSeed(seed: number, base: BaseState): number { return (seed ^ Math.imul(base.set, 73856093) ^ Math.imul(base.leg, 19349663)) >>> 0; }
export function trainingSequence(order: 'ascending' | 'descending' | 'random', bull: boolean, seed: number): number[] {
  const targets = Array.from({ length: 20 }, (_, i) => i + 1);
  if (order === 'descending') targets.reverse();
  if (order === 'random') {
    const random = trainingRandom(seed);
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [targets[i], targets[j]] = [targets[j]!, targets[i]!];
    }
  }
  if (bull) targets.push(25);
  return targets;
}
export type TargetMode = 'full' | 'single' | 'outer-single' | 'double' | 'triple';
export function trainingHit(segment: Segment, target: number, mode: TargetMode): boolean {
  if (segment.number !== target || segment.ring === 'MISS') return false;
  if (target === 25) return mode === 'full' || (mode === 'single' || mode === 'outer-single' ? segment.ring === 'OUTER_BULL' : segment.ring === 'BULL');
  if (mode === 'full') return true;
  if (mode === 'single') return segment.ring === 'SINGLE_INNER' || segment.ring === 'SINGLE_OUTER';
  return segment.ring === ({ 'outer-single': 'SINGLE_OUTER', double: 'DOUBLE', triple: 'TRIPLE' } as const)[mode];
}
export function trainingHint(target: number, mode: TargetMode): string {
  if (target === 25) return mode === 'double' || mode === 'triple' ? 'BULL' : '25';
  return mode === 'double' ? `D${target}` : mode === 'triple' ? `T${target}` : mode === 'full' ? String(target) : `S${target}`;
}
export function outSatisfied(segment: Segment, mode: InOutMode): boolean {
  return mode === 'straight' || (mode === 'double' ? isDouble(segment) : isMaster(segment));
}
export function turnDarts(base: BaseState) { return base.turn.map(d => ({ id: d.id, label: segmentLabel(d.segment), value: d.value, coords: d.coords })); }
