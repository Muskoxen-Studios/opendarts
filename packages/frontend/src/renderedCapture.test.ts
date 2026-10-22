import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderedCapture } from './renderedCapture.ts';
import type { RenderFrameBatch } from './nativeDetector.ts';

const images = { cam0: 'AA==', cam1: 'AQ==', cam2: 'Ag==' };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('rendered upload lifecycle', () => {
  it('waits for acknowledgement, sends one logical image tick, and advances sequence', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { ok: boolean }) => void;
    const send = vi.fn((_batch: RenderFrameBatch, _signal: AbortSignal) => new Promise<{ ok: boolean }>(r => { resolve = r; }));
    const read = vi.fn(() => images); const fault = vi.fn(); const ack = vi.fn();
    const capture = new RenderedCapture(read, send, fault, ack);
    expect(send).not.toHaveBeenCalled(); // Mount/construct is scene-only, never implicit capture.
    capture.start('render-1');
    expect(send).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1);
    const batch = send.mock.calls[0][0];
    expect(Object.keys(batch).sort()).toEqual(['images', 'sequence', 'session', 'timestampMs']);
    expect(batch).toEqual({ session: 'render-1', sequence: 0, timestampMs: expect.any(Number), images });
    expect(batch.timestampMs).toBeGreaterThanOrEqual(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    resolve({ ok: true }); await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0].sequence).toBe(1);
    expect(ack).toHaveBeenCalledWith(0); expect(fault).not.toHaveBeenCalled();
    capture.stop();
  });

  it('aborts on cleanup and ignores late acknowledgements without scheduling more uploads', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { ok: boolean }) => void;
    const send = vi.fn((_batch: RenderFrameBatch, _signal: AbortSignal) => new Promise<{ ok: boolean }>(r => { resolve = r; }));
    const ack = vi.fn(); const fault = vi.fn();
    const capture = new RenderedCapture(() => images, send, fault, ack);
    capture.start('old'); const signal = send.mock.calls[0][1];
    capture.stop(); expect(signal.aborted).toBe(true);
    resolve({ ok: true }); await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(1); expect(ack).not.toHaveBeenCalled(); expect(fault).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a stale session rejection instead of retrying potentially scoring frames', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({ ok: false, error: 'stale render session' });
    const fault = vi.fn(); const capture = new RenderedCapture(() => images, send, fault);
    capture.start('stale'); await vi.advanceTimersByTimeAsync(1000);
    expect(fault).toHaveBeenCalledWith('stale render session'); expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled requests and reports timeout when fetch rejects on abort', async () => {
    vi.useFakeTimers();
    const send = vi.fn((_batch: RenderFrameBatch, signal: AbortSignal) => new Promise<{ ok: boolean }>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Upload aborted')), { once: true });
    }));
    const fault = vi.fn(); const capture = new RenderedCapture(() => images, send, fault);
    capture.start('session'); await vi.advanceTimersByTimeAsync(5001);
    expect(send.mock.calls[0][1].aborted).toBe(true); expect(fault).toHaveBeenCalledWith('Upload aborted');
    expect(send).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
