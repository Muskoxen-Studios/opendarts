import type { RenderFrameBatch, RenderImages } from './nativeDetector.ts';

/** One acknowledged batch at a time. Stop invalidates late responses and aborts the request. */
export class RenderedCapture {
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private revision = 0;
  private sequence = 0;
  private active = false;
  constructor(
    private images: () => RenderImages,
    private send: (batch: RenderFrameBatch, signal: AbortSignal) => Promise<{ ok: boolean; error?: string }>,
    private fault: (message: string) => void,
    private acknowledged: (sequence: number) => void = () => {},
  ) {}
  start(session: string): void {
    this.stop(); this.active = true; this.sequence = 0;
    void this.tick(session, this.revision);
  }
  stop(): void {
    this.active = false; this.revision++; clearTimeout(this.timer); this.controller?.abort();
    this.controller = undefined;
  }
  private async tick(session: string, revision: number): Promise<void> {
    if (!this.active || revision !== this.revision) return;
    const started = performance.now();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const sequence = this.sequence++;
      const result = await this.send({ session, sequence, timestampMs: performance.now(), images: this.images() }, controller.signal);
      if (!this.active || revision !== this.revision) return;
      if (!result || result.ok !== true) throw new Error(result?.error ?? 'Frame batch rejected');
      this.acknowledged(sequence);
      this.timer = setTimeout(() => void this.tick(session, revision), Math.max(0, 200 - (performance.now() - started)));
    } catch (error) {
      if (!this.active || revision !== this.revision) return;
      this.stop(); this.fault((error as Error).message);
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
