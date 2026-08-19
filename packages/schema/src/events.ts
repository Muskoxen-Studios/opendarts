import { z } from 'zod';
import type { Ring, Segment } from './board.ts';

export const RingSchema = z.enum([
  'MISS',
  'SINGLE_INNER',
  'SINGLE_OUTER',
  'DOUBLE',
  'TRIPLE',
  'OUTER_BULL',
  'BULL',
]);

export const SegmentSchema = z.object({
  number: z.number().int().min(0).max(25),
  ring: RingSchema,
});

/**
 * Board-space coordinates of a dart.
 *
 * DELIBERATELY UNUSED BY GAME LOGIC. The Autodarts board reports a `coords`
 * field on each throw, but its units, origin and axis directions are not yet
 * established (see recon/FINDINGS.md §3). Until a real throw capture settles
 * that, this stays null for board-sourced throws and nothing downstream may
 * depend on it.
 *
 * Scoring, engines, stats and achievements must all behave correctly when this
 * is null. Only optional visualisations may read it, and they must degrade.
 */
export const CoordsSchema = z.object({ x: z.number(), y: z.number() });

export const ThrowSourceSchema = z.enum(['board', 'simulator', 'manual']);

export const DartThrowSchema = z.object({
  id: z.string(),
  ts: z.string(),
  segment: SegmentSchema,
  /** Points scored. Derived from `segment`; never trusted from the wire. */
  value: z.number().int().min(0).max(60),
  coords: CoordsSchema.nullable(),
  source: ThrowSourceSchema,
});

export type Coords = z.infer<typeof CoordsSchema>;
export type ThrowSource = z.infer<typeof ThrowSourceSchema>;
export type DartThrow = z.infer<typeof DartThrowSchema>;

/**
 * Board status, mirroring the Board Manager's own enum.
 * Note `Throw` means "armed and waiting for a dart", not "a dart just landed".
 */
export const BoardStatusSchema = z.enum([
  'Starting',
  'Stopping',
  'Stopped',
  'Throw',
  'Takeout',
  'Takeout in progress',
  'Calibrating',
  'Offline',
  'Setup',
  'Error',
]);
export type BoardStatus = z.infer<typeof BoardStatusSchema>;

/**
 * Our own board event vocabulary. Intentionally NOT shaped like the Autodarts
 * payload -- this is the anti-corruption boundary. Autodarts field names appear
 * only in packages/bridge/src/adapters/autodarts.ts.
 */
export const BoardEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('throw.detected'), throw: DartThrowSchema }),
  z.object({ type: z.literal('takeout.started') }),
  z.object({ type: z.literal('takeout.completed') }),
  z.object({
    type: z.literal('board.status'),
    status: BoardStatusSchema,
    running: z.boolean(),
  }),
  z.object({ type: z.literal('board.connected') }),
  z.object({ type: z.literal('board.disconnected'), reason: z.string().optional() }),
  /** Emitted from the `stats` channel at ~1/s; our liveness signal. */
  z.object({ type: z.literal('board.heartbeat'), fps: z.number().optional() }),
]);

export type BoardEvent = z.infer<typeof BoardEventSchema>;

export function makeThrow(
  segment: Segment,
  opts: {
    id: string;
    ts?: string;
    coords?: Coords | null;
    source?: ThrowSource;
    value: number;
  },
): DartThrow {
  return {
    id: opts.id,
    ts: opts.ts ?? new Date().toISOString(),
    segment,
    value: opts.value,
    coords: opts.coords ?? null,
    source: opts.source ?? 'board',
  };
}

export type { Ring, Segment };
