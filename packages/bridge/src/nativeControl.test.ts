import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeBoardCommand, nativeBoardState, nativeHealth } from './nativeControl.ts';
import { nativeProxy } from './nativeProxy.ts';

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => err ? reject(err) : resolve());
  })));
});

async function detector() {
  let running = false;
  let numThrows = 2;
  let physicalDarts = 2;
  let statusCode = 200;
  let cameraType = 'image/png';
  const calls: { method?: string; path?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    calls.push({ method: req.method, path: req.url, body: text ? JSON.parse(text) : undefined });
    if (statusCode !== 200) { res.writeHead(statusCode); res.end('unavailable'); return; }
    if (req.url === '/control/start' && req.method === 'POST') running = true;
    else if (req.url === '/control/stop' && req.method === 'POST') running = false;
    else if (req.url === '/control/reset' && req.method === 'POST') numThrows = 0;
    else if (req.url === '/sim/takeout' && req.method === 'POST') physicalDarts = numThrows = 0;
    else if (req.url === '/sim/reset' && req.method === 'POST') physicalDarts = numThrows = 0;
    else if (req.url === '/sim/throw' && req.method === 'POST') { physicalDarts++; numThrows++; }
    else if (req.url === '/cameras/cam-1/frame' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': cameraType });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    } else if (req.url === '/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ connected: true, running, status: running ? 'Throw' : 'Stopped', numThrows, detectorDiagnostic: 'private' }));
      return;
    } else if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(204); res.end();
  });
  const url = await listen(server);
  return { url, calls, get running() { return running; }, get physicalDarts() { return physicalDarts; },
    fail(code: number) { statusCode = code; }, cameraContentType(type: string) { cameraType = type; } };
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}
async function proxy(url: string, kind: 'native' | 'simulator' = 'native') {
  return listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const handled = await nativeProxy(req, res, kind === 'native' ? { kind, url } : { kind }, text ? JSON.parse(text) : undefined);
    if (!handled) { res.writeHead(404); res.end(); }
  }));
}

describe('native detector controls', () => {
  it('uses only POST /control commands and accepts empty 204 responses', async () => {
    const d = await detector();
    expect(await nativeBoardCommand(`${d.url}/`, 'start')).toEqual({ ok: true });
    expect(d.running).toBe(true);
    expect(await nativeBoardCommand(d.url, 'reset')).toEqual({ ok: true });
    expect(d.physicalDarts).toBe(2); // Counter reset must not physically remove darts.
    expect(d.running).toBe(true);
    expect((await nativeBoardState(d.url)).state).toMatchObject({ numThrows: 0, running: true });
    expect(await nativeBoardCommand(d.url, 'stop')).toEqual({ ok: true });
    expect(d.running).toBe(false);
    expect(d.calls.filter((call) => call.path?.startsWith('/control'))).toEqual([
      { method: 'POST', path: '/control/start', body: undefined },
      { method: 'POST', path: '/control/reset', body: undefined },
      { method: 'POST', path: '/control/stop', body: undefined },
    ]);
    expect(d.calls.some((call) => call.path?.startsWith('/api/'))).toBe(false);
  });
  it('reports unsupported calibration without making any request', async () => {
    const d = await detector();
    expect(await nativeBoardCommand(d.url, 'calibrate')).toMatchObject({ ok: false, error: expect.stringContaining('does not support') });
    expect(d.calls).toEqual([]);
  });
  it('normalizes state for common UI and keeps detector-only diagnostics separate', async () => {
    const d = await detector();
    expect(await nativeBoardState(d.url)).toEqual({ ok: true, state: { connected: true, running: false, status: 'Stopped', numThrows: 2 } });
    expect(await nativeHealth(d.url)).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
    expect(d.calls.map((call) => call.path)).toEqual(['/state', '/health']);
  });
  it('reports HTTP failures from commands, state and health', async () => {
    const d = await detector();
    d.fail(503);
    expect(await nativeBoardCommand(d.url, 'start')).toMatchObject({ ok: false, error: expect.stringContaining('503') });
    expect(await nativeBoardState(d.url)).toMatchObject({ ok: false, error: expect.stringContaining('503') });
    expect(await nativeHealth(d.url)).toMatchObject({ ok: false, error: expect.stringContaining('503') });
  });
  it('reports network and invalid state failures instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await nativeBoardCommand('http://detector', 'start')).ok).toBe(false);
    expect((await nativeBoardState('http://detector')).ok).toBe(false);
    expect((await nativeHealth('http://detector')).ok).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"running":"yes"}', { headers: { 'content-type': 'application/json' } })));
    expect((await nativeBoardState('http://detector')).ok).toBe(false);
  });
});

describe('native-only proxy routes', () => {
  it('proxies detector health and raw state independently of common board state', async () => {
    const d = await detector();
    const base = await proxy(d.url);
    expect(await (await fetch(`${base}/native/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/native/state`)).json()).toMatchObject({ detectorDiagnostic: 'private' });
  });
  it('simulates via image-coordinate HTTP, never direct segments', async () => {
    const d = await detector();
    const base = await proxy(d.url);
    const throwResponse = await fetch(`${base}/native/sim/throw`, { method: 'POST', body: JSON.stringify({ x_mm: -23.5, y_mm: 150 }) });
    expect(throwResponse.status).toBe(204);
    expect(d.calls[0]).toEqual({ method: 'POST', path: '/sim/throw', body: { x_mm: -23.5, y_mm: 150 } });
    expect(d.physicalDarts).toBe(3);
    expect((await fetch(`${base}/native/sim/takeout`, { method: 'POST' })).status).toBe(204);
    expect(d.physicalDarts).toBe(0);
    expect((await fetch(`${base}/native/sim/reset`, { method: 'POST' })).status).toBe(204);
  });
  it.each([{ segment: { number: 20, ring: 'TRIPLE' } }, { x_mm: 0 }, { x_mm: 1, y_mm: 2, segment: 'T20' }, { x_mm: '1', y_mm: 2 }])('rejects invalid simulation body %j before forwarding', async (body) => {
    const d = await detector();
    const base = await proxy(d.url);
    expect((await fetch(`${base}/native/sim/throw`, { method: 'POST', body: JSON.stringify(body) })).status).toBe(400);
    expect(d.calls).toEqual([]);
  });
  it('preserves optional partial-takeout counts and rejects invalid control bodies', async () => {
    const d = await detector();
    const base = await proxy(d.url);
    await fetch(`${base}/native/sim/takeout`, { method: 'POST', body: '{"count":1}' });
    expect(d.calls[0]).toEqual({ method: 'POST', path: '/sim/takeout', body: { count: 1 } });
    for (const [path, body] of [['takeout', '{"count":0}'], ['reset', '{"count":1}'], ['reset', 'null']]) {
      expect((await fetch(`${base}/native/sim/${path}`, { method: 'POST', body })).status).toBe(400);
    }
    expect(d.calls).toHaveLength(1);
  });
  it('streams camera image bytes with no caching', async () => {
    const d = await detector();
    const base = await proxy(d.url);
    const response = await fetch(`${base}/native/cameras/cam-1/frame`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });
  it('rejects non-image camera responses and preserves upstream failures', async () => {
    const d = await detector();
    const base = await proxy(d.url);
    d.cameraContentType('text/html');
    const invalid = await fetch(`${base}/native/cameras/cam-1/frame`);
    expect(invalid.status).toBe(502);
    await invalid.text();
    d.fail(503);
    const failed = await fetch(`${base}/native/state`);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('unavailable');
  });
  it('refuses native proxy calls when another source is active', async () => {
    const d = await detector();
    const base = await proxy(d.url, 'simulator');
    expect((await fetch(`${base}/native/state`)).status).toBe(409);
    expect(d.calls).toEqual([]);
  });
  it('does not forward unknown routes, methods, query strings or encoded paths', async () => {
    const d = await detector();
    const base = await proxy(d.url);
    for (const path of ['/native/api/start', '/native/sim/throw', '/native/state?url=evil', '/native/cameras/a%2Fb/frame']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect(d.calls).toEqual([]);
  });
});
