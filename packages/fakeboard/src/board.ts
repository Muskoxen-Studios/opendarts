import type { BoardStatus, Segment } from '@darts/schema';
import { toRawThrow, type RawThrow } from './payload.ts';

/**
 * The body of a `state` frame, and of `GET /api/state`.
 * Field names from FINDINGS §2 (CONFIRMED against the real board).
 */
export interface BoardStateData {
  connected: boolean;
  running: boolean;
  status: BoardStatus;
  event: string;
  numThrows: number;
  throws: RawThrow[];
}

export type StateListener = (data: BoardStateData) => void;

/**
 * The board's state machine.
 *
 * The one behaviour worth being pedantic about: `state` is EDGE-TRIGGERED. A
 * 45 s capture of a running, idle board produced zero `state` frames
 * (FINDINGS §1). So this class emits only on an actual transition, never on a
 * timer — which is what makes it a real test of the bridge's rule that liveness
 * comes from `stats` and never from `state`.
 */
export class FakeBoard {
  #status: BoardStatus = 'Stopped';
  #running = false;
  /**
   * Only "Started" is confirmed (FINDINGS §2). The rest are plausible labels;
   * nothing in the bridge reads this field, so a wrong guess costs nothing.
   */
  #event = 'Stopped';
  #throws: RawThrow[] = [];
  #listeners = new Set<StateListener>();

  on(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): BoardStateData {
    return {
      connected: true,
      running: this.#running,
      status: this.#status,
      event: this.#event,
      numThrows: this.#throws.length,
      // Copied so a listener cannot mutate the board through its own frame.
      throws: this.#throws.map((t) => ({ ...t })),
    };
  }

  get running(): boolean {
    return this.#running;
  }

  #transition(status: BoardStatus, event: string): void {
    this.#status = status;
    this.#event = event;
    const frame = this.snapshot();
    for (const listener of this.#listeners) listener(frame);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    // Observed on the real board: PUT /api/start -> running:true,
    // status:"Throw", event:"Started". "Throw" means armed and waiting.
    this.#transition('Throw', 'Started');
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#throws = [];
    this.#transition('Stopped', 'Stopped');
  }

  /** POST /api/reset — clears the throw counter without stopping detection. */
  reset(): void {
    this.#throws = [];
    this.#transition(this.#running ? 'Throw' : 'Stopped', 'Reset');
  }

  /**
   * Land a dart. `throws[]` accumulates for the visit rather than reporting
   * only the newest dart — the behaviour `autodartsSource` already assumes when
   * it tracks `emittedThrows`. ASSUMED, not confirmed (FINDINGS §3).
   */
  throwDart(segment: Segment): void {
    if (!this.#running) return;
    this.#throws.push(toRawThrow(segment));
    this.#transition('Throw', 'Throw');
  }

  /** Darts are being pulled out; they are still in `throws[]` at this point. */
  takeoutStart(): void {
    if (!this.#running) return;
    this.#transition('Takeout in progress', 'Takeout');
  }

  /** Darts are out: the array shrinks to empty, which is the bridge's cue. */
  takeoutComplete(): void {
    if (!this.#running) return;
    this.#throws = [];
    this.#transition('Throw', 'Takeout');
  }

  /** Auto-calibration, as triggered by POST /api/config/calibration/auto. */
  calibrate(): void {
    this.#transition('Calibrating', 'Calibrating');
    this.#transition(this.#running ? 'Throw' : 'Stopped', 'Calibrated');
  }
}
