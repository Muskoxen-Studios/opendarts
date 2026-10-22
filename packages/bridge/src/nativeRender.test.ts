import { describe, expect, it } from 'vitest';
import { MAX_RENDER_BODY, renderBody } from './nativeRender.ts';

function configuration(width: number, height: number) {
  const reference = Buffer.alloc(width * height, 180).toString('base64');
  const camera = { K: [400, 0, width / 2, 0, 400, height / 2, 0, 0, 1],
    R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 100], reference };
  return { width, height, cameras: { cam0: camera, cam1: camera, cam2: camera } };
}

describe('rendered grayscale boundary', () => {
  it.each([[640, 480], [1280, 720]])('accepts exact %i×%i grayscale configuration and frames', (width, height) => {
    const config = configuration(width, height);
    expect(renderBody('/native/render/configure', config).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(config))).toBeLessThan(MAX_RENDER_BODY);
    const batch = { session: 'session', sequence: 0, timestampMs: 0,
      images: Object.fromEntries(Object.entries(config.cameras).map(([id, camera]) => [id, camera.reference])) };
    expect(renderBody('/native/render/frames', batch).success).toBe(true);
    if (width === 1280) expect(Buffer.byteLength(JSON.stringify(batch))).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('rejects oversized dimensions, mismatched references and truth fields', () => {
    const config = configuration(1280, 720);
    expect(renderBody('/native/render/configure', { ...config, width: 1281 }).success).toBe(false);
    expect(renderBody('/native/render/configure', { ...config, height: 721 }).success).toBe(false);
    config.cameras.cam0.reference = 'AAAA';
    expect(renderBody('/native/render/configure', config).success).toBe(false);
    expect(renderBody('/native/render/configure', { ...configuration(640, 480), coords: [0, 100] }).success).toBe(false);
  });
});
