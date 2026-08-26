import type { BoardEvent } from '@darts/schema';

export type EventSink = (event: BoardEvent) => void;

export interface Source {
  readonly name: string;
  start(emit: EventSink): void | Promise<void>;
  stop(): void | Promise<void>;
  /**
   * Simulator, replay and autodarts all accept injected darts; only replay's
   * playback of a fixed capture has no use for it. Coordinates are optional
   * and pass straight through: the virtual board knows exactly where it was
   * clicked, and that is real enough to plot.
   */
  inject?(
    segment: import('@darts/schema').Segment,
    coords?: import('@darts/schema').Coords | null,
  ): void;
  /**
   * Called just before the board's own throw counter is zeroed on our
   * instruction, so a source that tracks that counter can re-baseline without
   * mistaking the drop for a takeout. Only the board source has a counter to
   * keep in step; the others do not implement it.
   */
  noteCounterReset?(): void;
}
