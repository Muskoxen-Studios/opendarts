import type { BoardEvent, Coords, Segment } from '@darts/schema';
import { buildSource, describeSource, type SourceConfig } from './sourceConfig.ts';
import type { Source } from './sources/types.ts';

export type Emit = (event: BoardEvent) => void;

/**
 * Owns the active source and swaps it on demand.
 *
 * Switching is guarded by a generation counter. A source that has been replaced
 * can still have a socket closing or a timer pending, and without the guard a
 * stale board connection could deliver a throw *after* the switch -- injecting a
 * dart from the old source into a match now being played on the new one.
 */
export class SourceManager {
  private emit: Emit;
  private source: Source | null = null;
  private currentConfig: SourceConfig;
  private generation = 0;
  private makeSource: (config: SourceConfig) => Source;

  constructor(
    initial: SourceConfig,
    emit: Emit,
    makeSource: (config: SourceConfig) => Source = buildSource,
  ) {
    this.currentConfig = initial;
    this.emit = emit;
    this.makeSource = makeSource;
  }

  get config(): SourceConfig {
    return this.currentConfig;
  }

  get name(): string {
    return this.source?.name ?? 'stopped';
  }

  get description(): string {
    return describeSource(this.currentConfig);
  }

  /** True when the active source accepts injected darts. */
  get acceptsInjection(): boolean {
    return typeof this.source?.inject === 'function';
  }

  start(): void {
    this.startInternal(this.currentConfig);
  }

  /** Replace the running source. Returns the config actually applied. */
  apply(config: SourceConfig): SourceConfig {
    this.stop();
    this.currentConfig = config;
    this.startInternal(config);
    return config;
  }

  stop(): void {
    // Bump first: anything the old source emits while shutting down is ignored.
    this.generation += 1;
    const previous = this.source;
    this.source = null;
    if (previous) {
      try {
        void previous.stop();
      } catch (err) {
        console.error('[bridge] error stopping source:', err);
      }
      this.emit({ type: 'board.disconnected', reason: 'source changed' });
    }
  }

  /**
   * Tell the active source we are about to zero the board's throw counter, so
   * the darts already in the board are not read as having been pulled out.
   */
  noteCounterReset(): void {
    this.source?.noteCounterReset?.();
  }

  inject(segment: Segment, coords?: Coords | null): boolean {
    if (!this.source?.inject) return false;
    this.source.inject(segment, coords);
    return true;
  }

  private startInternal(config: SourceConfig): void {
    const generation = this.generation;
    const guarded: Emit = (event) => {
      if (generation !== this.generation) return;
      this.emit(event);
    };
    this.source = this.makeSource(config);
    console.log(`[bridge] source -> ${describeSource(config)}`);
    void this.source.start(guarded);
  }
}
