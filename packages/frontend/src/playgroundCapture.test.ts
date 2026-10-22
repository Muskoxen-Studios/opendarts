import { describe, expect, it } from 'vitest';
import { PlaygroundCapture, playgroundSegment } from './playgroundCapture.ts';
import { DEFAULT_DART } from './cameraRig3d.ts';
import type { RenderConfiguration, RenderFrameBatch } from './nativeDetector.ts';

const batch = (sequence: number): RenderFrameBatch => ({ session: 'render-1', sequence, timestampMs: 10,
  images: { cam0: 'AA==', cam1: 'AQ==', cam2: 'Ag==' } });
const camera = { K: [1], R: [2], t: [3], reference: 'BA==' };
const configuration: RenderConfiguration = { width: 640, height: 480, cameras: { cam0: camera, cam1: camera, cam2: camera } };

describe('playground failure capture', () => {
  it('freezes the first submitted scene and exact configuration independently of later changes', () => {
    const capture = new PlaygroundCapture();
    const config = structuredClone(configuration); const submitted = batch(0); const dart = { ...DEFAULT_DART };
    capture.configure(config); capture.submit(submitted, [dart], { radius: 330 });
    capture.freeze('radial boundary rejection', null);
    const original = capture.export();
    submitted.images.cam0 = 'changed'; dart.x = 123; config.cameras.cam0.reference = 'changed';
    capture.configure(configuration); capture.submit(batch(1), [], {});
    expect(capture.freeze('stream stalled >3s', null)).toBe(false);
    expect(capture.export()).toBe(original);
    const json = JSON.parse(original!);
    expect(json.reason).toBe('radial boundary rejection');
    expect(json.configuration.cameras.cam0.reference).toBe('BA==');
    expect(json.submitted[0].batch).toEqual(batch(0));
    expect(Object.keys(json.submitted[0].batch).sort()).toEqual(['images', 'sequence', 'session', 'timestampMs']);
    expect(json.submitted[0].sceneTruth.darts[0].x).toBe(DEFAULT_DART.x);
    capture.clear(); expect(capture.export()).toBeNull();
  });
  it('bounds the recent window and omits oversized images', () => {
    const capture = new PlaygroundCapture(4096, 2);
    for (let i = 0; i < 5; i++) capture.submit(batch(i), [], {});
    capture.submit({ ...batch(5), images: { cam0: 'a'.repeat(5000), cam1: '', cam2: '' } }, [], {});
    capture.freeze('fault', null);
    expect(JSON.parse(capture.export()!).submitted.map((s: { batch: RenderFrameBatch }) => s.batch.sequence)).toEqual([3, 4]);
  });
  it('retains 720p configuration and the latest three batches within unchanged memory budgets', () => {
    const capture = new PlaygroundCapture();
    const reference = Buffer.alloc(1280 * 720, 180).toString('base64');
    const c = { ...camera, reference };
    capture.configure({ width: 1280, height: 720, cameras: { cam0: c, cam1: c, cam2: c } });
    for (let sequence = 0; sequence < 5; sequence++) {
      capture.submit({ ...batch(sequence), images: { cam0: reference, cam1: reference, cam2: reference } }, [DEFAULT_DART], {});
    }
    capture.freeze('fault', null);
    const saved = JSON.parse(capture.export()!);
    expect(saved.configuration.width).toBe(1280);
    expect(saved.configuration.cameras.cam0.reference).toBe(reference);
    expect(saved.submitted.map((s: { batch: RenderFrameBatch }) => s.batch.sequence)).toEqual([2, 3, 4]);
  });
  it('allows a new fault only after explicit discard', () => {
    const capture = new PlaygroundCapture(); capture.freeze('first', null); capture.clear();
    capture.submit(batch(2), [], {}); capture.freeze('second', null);
    expect(capture.reason).toBe('second');
  });
});

describe('comparison segments (not acceptance)', () => {
  it('uses schema rings and x-right/y-up wedges', () => {
    expect(playgroundSegment(0, 102)).toBe('T20 (60)');
    expect(playgroundSegment(102, 0)).toBe('T6 (18)');
    expect(playgroundSegment(0, -165)).toBe('D3 (6)');
    expect(playgroundSegment(0, 0)).toBe('BULL (50)');
    expect(playgroundSegment(0, 12)).toBe('25 (25)');
    expect(playgroundSegment(0, 180)).toBe('MISS (0)');
    expect(playgroundSegment(0, 96.99)).toBe('S20 (20)');
    expect(playgroundSegment(0, 97)).toBe('T20 (60)');
    expect(playgroundSegment(NaN, 0)).toBe('Unknown');
  });
});
