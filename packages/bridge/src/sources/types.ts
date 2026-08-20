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
}
