import { z } from 'zod';
import { BOARD_MM } from './board.ts';
import type { Coords } from './events.ts';
import type { Player } from './match.ts';

/** Bull-off is match setup, not a scored game or a career-statistics event. */
export interface BullOffResult {
  label: string;
  distanceMm: number | null;
  band: number;
  coords: Coords | null;
}

export interface BullOffView {
  id: string;
  revision: number;
  players: Player[];
  groups: string[][];
  round: number;
  queue: string[];
  activePlayerId: string | null;
  awaitingTakeout: boolean;
  complete: boolean;
  canUndo: boolean;
  retry: boolean;
  results: Record<string, BullOffResult>;
}

export const BullOffStartSchema = z.object({ playerIds: z.array(z.string()).min(2).max(32) })
  .refine(value => new Set(value.playerIds).size === value.playerIds.length, 'Select distinct players');

export const BullOffCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NEXT') }),
  z.object({ type: z.literal('UNDO') }),
  z.object({ type: z.literal('RESTART') }),
  z.object({ type: z.literal('CANCEL') }),
  z.object({ type: z.literal('FINISH') }),
  z.object({ type: z.literal('MEASURE'), distanceMm: z.number().finite().min(0).max(BOARD_MM.BOARD_OUTER) }),
]);
export type BullOffCommand = z.infer<typeof BullOffCommandSchema>;
