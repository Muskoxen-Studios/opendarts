import { BOARD_MM, SEGMENT_ORDER, segmentLabel, segmentValue, type Segment } from '@darts/schema';
import type { DartSpec } from './cameraRig3d.ts';
import type { NativeState, RenderConfiguration, RenderFrameBatch } from './nativeDetector.ts';

/** Display geometry only: boundaries use the schema radii, not detector acceptance rules. */
export function playgroundSegment(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Unknown';
  const radius = Math.hypot(x, y);
  const number = SEGMENT_ORDER[Math.floor(((Math.atan2(x, y) * 180 / Math.PI + 369) % 360) / 18)]!;
  const segment: Segment = radius > BOARD_MM.DOUBLE_OUTER ? { number: 0, ring: 'MISS' }
    : radius < BOARD_MM.BULL_INNER ? { number: 25, ring: 'BULL' }
    : radius < BOARD_MM.BULL_OUTER ? { number: 25, ring: 'OUTER_BULL' }
    : { number, ring: radius >= BOARD_MM.DOUBLE_INNER ? 'DOUBLE'
      : radius >= BOARD_MM.TRIPLE_OUTER ? 'SINGLE_OUTER'
      : radius >= BOARD_MM.TRIPLE_INNER ? 'TRIPLE' : 'SINGLE_INNER' };
  return `${segmentLabel(segment)} (${segmentValue(segment)})`;
}

interface SubmittedScene {
  batch: RenderFrameBatch;
  sceneTruth: { darts: DartSpec[]; rig: Record<string, number> };
}
interface FailureCapture {
  format: 'open-darts-rendered-failure'; version: 1; capturedAt: string; reason: string;
  configuration: RenderConfiguration | null;
  submitted: SubmittedScene[];
  detector: NativeState | null;
  provenance: string;
  limitations: string[];
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Browser-memory only. Freeze the first fault; later preview edits/polls cannot replace it. */
export class PlaygroundCapture {
  private configuration: RenderConfiguration | null = null;
  private submitted: SubmittedScene[] = [];
  private bytes = 0;
  private failure: FailureCapture | null = null;
  constructor(private maxBytes = 24 * 1024 * 1024, private maxBatches = 16) {}
  configure(configuration: RenderConfiguration): void {
    if (this.failure) return;
    this.configuration = JSON.stringify(configuration).length * 2 <= 8 * 1024 * 1024 ? copy(configuration) : null;
        this.submitted = []; this.bytes = 0;
  }
  submit(batch: RenderFrameBatch, darts: DartSpec[], rig: Record<string, number>): void {
    if (this.failure) return;
    const scene = copy({ batch, sceneTruth: { darts, rig } });
    const size = JSON.stringify(scene).length * 2;
    if (size > this.maxBytes) return;
    this.submitted.push(scene); this.bytes += size;
    while (this.submitted.length > this.maxBatches || this.bytes > this.maxBytes) {
      this.bytes -= JSON.stringify(this.submitted.shift()!).length * 2;
    }
  }
  freeze(reason: string, detector: NativeState | null): boolean {
    if (this.failure) return false;
    // Diagnostics are service-controlled. Bound retained metadata independently of images.
    const metadata = detector && JSON.stringify(detector).length <= 256 * 1024 ? copy(detector) : null;
    this.failure = {
      format: 'open-darts-rendered-failure', version: 1, capturedAt: new Date().toISOString(), reason,
      configuration: this.configuration, submitted: this.submitted, detector: metadata,
      provenance: 'Only source/diagnostics exposed by the existing state API are captured. Parameter file/hash and service build are unknown unless present in diagnostics.',
      limitations: ['Recent submitted window only (16 batches / 24 MiB, configuration 8 MiB, metadata 256 KiB); oversized entries omitted. Not full history; submission does not prove processing or acceptance.',
        'Polling does not associate diagnostics with an exact frame sequence. The last submitted scene is not necessarily the rejected frame.',
        'Scene truth is offline annotation only and was never sent to the detector.',
        'Coordinate-derived segments are comparisons, not scoring receipts. Match state is not captured.'],
    };
    return true;
  }
  get reason(): string | null { return this.failure?.reason ?? null; }
  export(): string | null { return this.failure ? JSON.stringify(this.failure, null, 2) : null; }
  clear(): void { this.configuration = null; this.submitted = []; this.bytes = 0; this.failure = null; }
}
