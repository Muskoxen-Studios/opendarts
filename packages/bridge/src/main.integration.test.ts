import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { startFakeBoard, type RunningFakeBoard } from '@darts/fakeboard';

let child: ChildProcess | null = null;
let detector: Server | null = null;
let autodarts: RunningFakeBoard | null = null;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  child = null;
  detector?.closeAllConnections();
  if (detector) await new Promise<void>((resolve) => detector!.close(() => resolve()));
  detector = null;
  await autodarts?.close();
  autodarts = null;
  vi.restoreAllMocks();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server port');
  return address.port;
}

it('routes native settings, board controls and proxies through the running bridge, preserving fallbacks', { timeout: 10_000 }, async () => {
  const calls: { method?: string; path?: string }[] = [];
  detector = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the image-simulator request body. */ }
    calls.push({ method: req.method, path: req.url });
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/state'
        ? { running: true, status: 'Throw', occupancy: 2, session: 'test', cameras: [] }
        : { ok: true }));
    }
  });
  const detectorUrl = `http://127.0.0.1:${await listen(detector)}`;
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], {
    env: { ...process.env, SOURCE: 'native', DETECTOR_URL: detectorUrl, BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr!.on('data', (chunk) => { output += chunk.toString(); });
  await vi.waitFor(async () => {
    expect(child!.exitCode, output).toBeNull();
    expect((await fetch(`${base}/health`)).ok).toBe(true);
  }, { timeout: 5000, interval: 25 });
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  expect((await request('/source')).body).toMatchObject({ config: { kind: 'native', url: detectorUrl }, acceptsInjection: false });
  expect((await request('/board/state')).body).toMatchObject({ ok: true, attached: true, state: { running: true, status: 'Throw', numThrows: 2 }, actions: ['start', 'stop', 'reset'] });
  for (const action of ['start', 'stop', 'reset']) {
    expect((await request(`/board/${action}`, 'POST')).body).toMatchObject({ ok: true, attached: true, action });
    expect(calls).toContainEqual({ method: 'POST', path: `/control/${action}` });
  }
  expect((await request('/board/calibrate', 'POST')).body).toMatchObject({ ok: false, error: expect.stringContaining('does not support') });
  expect(calls.some((call) => call.path?.startsWith('/api'))).toBe(false);
  expect((await request('/test', 'POST', { kind: 'native', url: detectorUrl })).body).toMatchObject({ ok: true });
  expect((await request('/native/state')).body).toMatchObject({ occupancy: 2, session: 'test' });
  expect((await request('/native/sim/throw', 'POST', { x_mm: 0, y_mm: 100 })).body).toMatchObject({ ok: true });
  const reference = Buffer.alloc(1280 * 720, 180).toString('base64');
  const camera = { K: [640, 0, 640, 0, 640, 360, 0, 0, 1], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 100], reference };
  const configuration = { width: 1280, height: 720, cameras: { cam0: camera, cam1: camera, cam2: camera } };
  const batch = { session: 'session', sequence: 1, timestampMs: 100, images: { cam0: reference, cam1: reference, cam2: reference } };
  expect((await request('/native/render/configure', 'POST', configuration)).status).toBe(200);
  expect((await request('/native/render/frames', 'POST', batch)).status).toBe(200);
  expect(calls).toContainEqual({ method: 'POST', path: '/render/configure' });
  expect(calls).toContainEqual({ method: 'POST', path: '/render/frames' });
  const uploads = () => calls.filter(call => call.path?.startsWith('/render/'));
  const count = uploads().length;
  // Raw padding tests the read cap, before JSON parsing or schema validation.
  for (const route of ['configure', 'frames']) {
    const exact = JSON.stringify({ padding: 'a'.repeat(6 * 1024 * 1024 - 14) });
    const boundary = await fetch(`${base}/native/render/${route}`, { method: 'POST', body: exact });
    expect(boundary.status).toBe(400); // Fits the cap but is not an allowed payload.
    await boundary.json();
    const oversized = await fetch(`${base}/native/render/${route}`, { method: 'POST', body: exact + ' ' });
    expect(oversized.status).toBe(413);
    await oversized.json();
  }
  expect((await request('/native/render/reset', 'POST', { session: 'a'.repeat(4096) })).status).toBe(413);
  expect((await request('/native/render/configure', 'POST', { ...configuration, coords: [0, 100] })).status).toBe(400);
  expect(uploads()).toHaveLength(count);
  expect((await request('/inject', 'POST', { segment: { number: 20, ring: 'TRIPLE' } })).status).toBe(409);
  expect((await request('/source', 'POST', { config: { kind: 'native', url: 'invalid' } })).status).toBe(400);
  expect((await request('/source')).body.config.kind).toBe('native');

  expect((await request('/source', 'POST', { config: { kind: 'simulator' } })).body).toMatchObject({ config: { kind: 'simulator' }, acceptsInjection: true });
  expect((await request('/board/state')).body).toMatchObject({ ok: false, attached: false });
  expect((await request('/native/state')).status).toBe(409);
  expect((await request('/inject', 'POST', { segment: { number: 20, ring: 'TRIPLE' } })).status).toBe(202);

  autodarts = await startFakeBoard({ port: 0 });
  expect((await request('/source', 'PUT', { config: { kind: 'autodarts', url: autodarts.url } })).body).toMatchObject({ config: { kind: 'autodarts' }, acceptsInjection: true });
  expect((await request('/board/start', 'POST')).body).toMatchObject({ ok: true, attached: true });
  expect((await request('/board/state')).body.state).toMatchObject({ running: true });
  expect((await request('/test', 'POST', { url: autodarts.url })).body).toMatchObject({ ok: true });
  expect((await request('/board/reset', 'POST')).body).toMatchObject({ ok: true });
  expect((await request('/board/calibrate', 'POST')).body).toMatchObject({ ok: true });
});
