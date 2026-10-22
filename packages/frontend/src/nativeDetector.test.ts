import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeFrameUrl, parseNativeState, renderedBaselineReady, renderedSnapshotGate, validImpact, validRemoveCount,
  type NativeState, type RenderSnapshotContext } from './nativeDetector.ts';
import { api } from './store.ts';
import { parseSegmentLabel } from '@darts/schema';

function snapshot() {
  return {
    session: 'session-1', source: 'synthetic', running: true, status: 'Throw', occupancy: 0,
    pending: { stableFrames: 3, requiredFrames: 3, adoptingBaseline: false }, faults: [],
    cameras: [0, 1, 2].map(i => ({ id: `cam${i}`, available: true, calibrated: true,
      frameUrl: `http://127.0.0.1:8091/cameras/cam${i}/frame` })),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native diagnostics', () => {
  it('parses synthetic and image replay snapshots without trusting frameUrl', () => {
    expect(parseNativeState(snapshot()).source).toBe('synthetic');
    expect(parseNativeState({ ...snapshot(), source: 'replay' }).source).toBe('replay');
    expect(parseNativeState({ ...snapshot(), source: 'rendered', status: 'Starting', renderSession: null })).toMatchObject({ source: 'rendered', status: 'Starting', renderSession: null });
    expect(parseNativeState({ ...snapshot(), source: 'rendered', renderSession: 'render-1', diagnostics: { cam0: { candidateLines: [] } } })).toMatchObject({ renderSession: 'render-1', diagnostics: { cam0: { candidateLines: [] } } });
    expect(parseNativeState(snapshot()).cameras[0]).not.toHaveProperty('frameUrl');
  });

  it.each([
    null, {}, { ...snapshot(), source: 'simulator' }, { ...snapshot(), running: 'true' },
    { ...snapshot(), occupancy: NaN }, { ...snapshot(), faults: [null] },
    { ...snapshot(), cameras: null }, { ...snapshot(), cameras: [{ id: '../health', available: true, calibrated: true }] },
    { ...snapshot(), cameras: [snapshot().cameras[0], snapshot().cameras[0]] },
    { ...snapshot(), renderSession: 7 }, { ...snapshot(), renderSession: '' },
    { ...snapshot(), diagnostics: [] }, { ...snapshot(), diagnostics: null },
    { ...snapshot(), pending: null }, { ...snapshot(), pending: { stableFrames: 0, requiredFrames: 0, adoptingBaseline: false } },
  ])('rejects malformed snapshots: %j', value => {
    expect(() => parseNativeState(value)).toThrow();
  });

  it('always constructs same-origin camera proxy URLs', () => {
    expect(nativeFrameUrl('cam0', 42)).toBe('/api/native/cameras/cam0/frame?t=42');
    expect(() => nativeFrameUrl('http://localhost:8091/frame', 0)).toThrow();
    expect(() => nativeFrameUrl('../health', 0)).toThrow();
  });

  it('validates millimetre coordinates and removal counts without coercion', () => {
    expect(validImpact(-200, 200)).toBe(true);
    for (const value of ['', '1', NaN, Infinity, 200.1, -201]) expect(validImpact(value, 0)).toBe(false);
    expect(validRemoveCount(1)).toBe(true);
    for (const value of [0, -1, 1.5, NaN, '1']) expect(validRemoveCount(value)).toBe(false);
  });
});

describe('rendered baseline and snapshot gating', () => {
  function rendered(overrides: Partial<NativeState> = {}): NativeState {
    return parseNativeState({ ...snapshot(), source: 'rendered', renderSession: 'render-new', ...overrides });
  }
  function context(overrides: Partial<RenderSnapshotContext> = {}): RenderSnapshotContext {
    return { detectorSession: 'session-1', renderSession: 'render-new', configuring: false,
      confirmed: false, previousSnapshot: null, ...overrides };
  }

  it('accepts all three unconfigured cameras at rendered startup without enabling scene changes', () => {
    const state = rendered({ status: 'Starting', renderSession: null,
      cameras: [0, 1, 2].map(i => ({ id: `cam${i}`, available: false, calibrated: false })),
      pending: { stableFrames: 0, requiredFrames: 3, adoptingBaseline: true } });
    expect(state.cameras).toHaveLength(3);
    expect(renderedBaselineReady(state, false)).toBe(false);
    expect(renderedBaselineReady(state, true)).toBe(false);
    expect(renderedSnapshotGate(state, context())).toBe('waiting');
  });

  it('ignores old baseline faults during configure and the initial empty uploads', () => {
    const old = rendered({ status: 'Error', renderSession: null, faults: ['awaiting configuration'] });
    expect(renderedSnapshotGate(old, context({ configuring: true, previousSnapshot: old }))).toBe('waiting');
    expect(renderedSnapshotGate(old, context({ previousSnapshot: old }))).toBe('waiting');
    // A poll that began before configure can finish afterward with a different object identity.
    expect(renderedSnapshotGate({ ...old }, context({ previousSnapshot: old }))).toBe('waiting');
    expect(renderedBaselineReady(old, false)).toBe(false);
    expect(renderedSnapshotGate(rendered(), context({ previousSnapshot: old }))).toBe('current');
  });

  it('requires session confirmation and a stable adopted baseline before allowing scene changes', () => {
    const state = rendered();
    expect(renderedBaselineReady(state, false)).toBe(false);
    expect(renderedBaselineReady(state, true)).toBe(true);
    expect(renderedBaselineReady(rendered({ pending: { stableFrames: 3, requiredFrames: 3, adoptingBaseline: true } }), true)).toBe(false);
    expect(renderedBaselineReady(rendered({ pending: { stableFrames: 2, requiredFrames: 3, adoptingBaseline: false } }), true)).toBe(false);
    expect(renderedBaselineReady(rendered({ cameras: state.cameras.map(c => ({ ...c, calibrated: false })) }), true)).toBe(false);
  });

  it('rejects current-session faults, restarts, source changes and stopped detectors', () => {
    expect(renderedSnapshotGate(rendered({ faults: ['occlusion'] }), context())).toBe('invalid');
    for (const state of [null, rendered({ session: 'restart' }), rendered({ source: 'synthetic' }), rendered({ running: false })]) {
      expect(renderedSnapshotGate(state, context({ configuring: true }))).toBe('invalid');
    }
    expect(renderedBaselineReady(rendered({ faults: ['occlusion'] }), true)).toBe(false);
  });

  it('disarms on a render session mismatch after confirmation, rather than treating it as startup', () => {
    expect(renderedSnapshotGate(rendered({ renderSession: 'superseded' }), context({ confirmed: true }))).toBe('stale');
    expect(renderedSnapshotGate(rendered({ renderSession: null }), context({ confirmed: true }))).toBe('stale');
  });
});

describe('native API requests', () => {
  function mockFetch(body: unknown = { ok: true }) {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('tests native with kind and URL while retaining Autodarts', async () => {
    const fetch = mockFetch();
    await api.testBoard('http://127.0.0.1:8091', 'native');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ kind: 'native', url: 'http://127.0.0.1:8091' });
    const autodartsFetch = mockFetch();
    await expect(api.testBoard('http://board:3180')).resolves.toEqual({ ok: true });
    expect(JSON.parse(autodartsFetch.mock.calls[0][1].body)).toEqual({ url: 'http://board:3180' });
  });

  it.each([
    ['throw', { x_mm: -10, y_mm: 102 }], ['takeout', { count: 1 }], ['takeout', {}], ['reset', {}],
  ] as const)('sends %s as image simulator requests, not injection', async (action, body) => {
    const fetch = mockFetch();
    const controller = new AbortController();
    await api.nativeSim(action, body, controller.signal);
    expect(fetch).toHaveBeenCalledWith(`/api/native/sim/${action}`, expect.objectContaining({
      method: 'POST', body: JSON.stringify(body), signal: controller.signal,
    }));
  });

  it('sends calibration and pixels only through the rendered proxy endpoints', async () => {
    const signal = new AbortController().signal;
    const camera = { K: [1, 0, 320, 0, 1, 240, 0, 0, 1], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 100], reference: 'AA==' };
    const config = { width: 640 as const, height: 480 as const, cameras: { cam0: camera, cam1: camera, cam2: camera } };
    let fetch = mockFetch({ ok: true, session: 'render-1' });
    await expect(api.nativeRenderConfigure(config, signal)).resolves.toEqual({ ok: true, session: 'render-1' });
    expect(fetch).toHaveBeenCalledWith('/api/native/render/configure', expect.objectContaining({ method: 'POST', body: JSON.stringify(config), signal }));
    const batch = { session: 'render-1', sequence: 0, timestampMs: 100, images: { cam0: 'AA==', cam1: 'AA==', cam2: 'AA==' } };
    fetch = mockFetch(); await api.nativeRenderFrames(batch, signal);
    expect(fetch).toHaveBeenCalledWith('/api/native/render/frames', expect.objectContaining({ method: 'POST', body: JSON.stringify(batch), signal }));
  });

  it('preserves the managed runtime detector URL returned by settings', async () => {
    const runtime = { bridgeWs: 'ws://127.0.0.1:8081', dbFile: 'data/darts.db', boardOnline: false,
      detectorUrl: 'http://127.0.0.1:43127', managedDetector: true };
    mockFetch({ celebrations: true, celebrationSeconds: 5, effects: 'full', bridge: null, runtime });
    expect((await api.settings()).runtime).toEqual(runtime);
  });

  it('proxies state and health and forwards abort signals', async () => {
    const signal = new AbortController().signal;
    let fetch = mockFetch(snapshot());
    await api.nativeState(signal);
    expect(fetch).toHaveBeenCalledWith('/api/native/state', expect.objectContaining({ signal }));
    fetch = mockFetch({ ok: true, session: 'session-1' });
    await api.nativeHealth(signal);
    expect(fetch).toHaveBeenCalledWith('/api/native/health', expect.objectContaining({ signal }));
  });

  it('surfaces unavailable detector errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"detector unavailable"}', { status: 503 })));
    await expect(api.nativeState()).rejects.toThrow('detector unavailable');
  });

  it('applies native through the existing source endpoint', async () => {
    const fetch = mockFetch();
    const config = { kind: 'native', url: 'http://127.0.0.1:8091' } as const;
    await api.setBridgeSource(config);
    expect(fetch).toHaveBeenCalledWith('/api/bridge/source', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ config }),
    }));
  });

  it('retains virtual-board injection for simulator and injection-capable replay', async () => {
    for (const kind of ['simulator', 'replay']) {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ config: { kind }, acceptsInjection: true })))
        .mockResolvedValueOnce(new Response('{"ok":true}'));
      vi.stubGlobal('fetch', fetch);
      const segment = parseSegmentLabel('T20')!;
      await api.simulate(segment, { x: 0, y: 0.6 });
      expect(fetch).toHaveBeenLastCalledWith('/api/simulate', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ segment, coords: { x: 0, y: 0.6 } }),
      }));
    }
  });

  it('blocks virtual-board injection when native is active', async () => {
    const fetch = mockFetch({ config: { kind: 'native', url: 'http://127.0.0.1:8091' }, acceptsInjection: false });
    await expect(api.simulate(parseSegmentLabel('T20')!)).rejects.toThrow('does not accept injected darts');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/bridge/source');
  });
});
