import { segmentValue, type Coords, type Segment } from '@darts/schema';
import type { EventSink, Source } from './types.ts';

/**
 * Simulator source: darts arrive by injection rather than from hardware.
 *
 * This is what makes the whole stack playable before the board's throw payload
 * is understood -- the frontend's virtual dartboard posts here, and every layer
 * above the adapter runs exactly as it will with real darts.
 */
export function simulatorSource(): Source {
  let emit: EventSink | null = null;
  let seq = 0;

  return {
    name: 'simulator',
    start(sink) {
      emit = sink;
      sink({ type: 'board.connected' });
      sink({ type: 'board.status', status: 'Throw', running: true });
    },
    stop() {
      emit = null;
    },
    inject(segment: Segment, coords?: Coords | null) {
      if (!emit) return;
      const ts = new Date().toISOString();
      emit({
        type: 'throw.detected',
        throw: {
          id: `sim-${ts}-${seq++}`,
          ts,
          segment,
          value: segmentValue(segment),
          // The virtual board reports where it was clicked, in board
          // millimetres from the centre. Board throws still arrive without
          // coordinates, so everything downstream must still cope with null.
          coords: coords ?? null,
          source: 'simulator',
        },
      });
    },
  };
}
