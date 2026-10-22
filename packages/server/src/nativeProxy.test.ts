import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { proxyNative } from './nativeProxy.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}`;
}

async function setup(contentType = 'image/png') {
  const requests: { path: string; method: string; body: string }[] = [];
  const upstream = await listen(createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({ path: req.url!, method: req.method!, body });
    res.writeHead(200, { 'content-type': contentType });
    res.end(Buffer.from([137, 80, 78, 71]));
  }));
  const url = await listen(createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    await proxyNative(req, res, upstream, body ? JSON.parse(body) : undefined);
  }));
  return { url, requests };
}

describe('native detector server proxy', () => {
  it('streams image bytes and drops preview cache-busting query parameters', async () => {
    const { url, requests } = await setup();
    const response = await fetch(`${url}/api/native/cameras/cam0/frame?t=12`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect(requests).toEqual([{ path: '/native/cameras/cam0/frame', method: 'GET', body: '' }]);
  });

  it('forwards JSON simulation requests, not arbitrary paths', async () => {
    const { url, requests } = await setup('application/json');
    const response = await fetch(`${url}/api/native/sim/throw`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x_mm: 0, y_mm: 102 }),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(requests).toEqual([{ path: '/native/sim/throw', method: 'POST', body: '{"x_mm":0,"y_mm":102}' }]);
    const denied = await fetch(`${url}/api/native/control/start`, { method: 'POST' });
    expect(denied.status).toBe(404);
    expect(requests).toHaveLength(1);
    await denied.json();
  });

  it('rejects successful non-image camera responses', async () => {
    const { url } = await setup('text/html');
    const response = await fetch(`${url}/api/native/cameras/cam0/frame`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'detector camera did not return an image' });
  });

  it('reports an unavailable bridge without a successful response', async () => {
    const url = await listen(createServer((req, res) => { void proxyNative(req, res, 'http://127.0.0.1:1'); }));
    const response = await fetch(`${url}/api/native/state`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining('bridge unreachable') });
  });
});


describe('render upload size boundary', () => {
  it('forwards all three 720p grayscale images unchanged through both upload routes', async () => {
    const { url, requests } = await setup('application/json');
    const reference = Buffer.alloc(1280 * 720, 180).toString('base64');
    const camera = { K: [640, 0, 640, 0, 640, 360, 0, 0, 1], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 100], reference };
    const bodies = {
      configure: { width: 1280, height: 720, cameras: { cam0: camera, cam1: camera, cam2: camera } },
      frames: { session: 'session', sequence: 1, timestampMs: 100, images: { cam0: reference, cam1: reference, cam2: reference } },
    };
    for (const [route, body] of Object.entries(bodies)) {
      const text = JSON.stringify(body);
      expect(Buffer.byteLength(text)).toBeGreaterThan(2 * 1024 * 1024);
      const response = await fetch(`${url}/api/native/render/${route}`, { method: 'POST', body: text });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(requests.at(-1)?.body).toBe(text);
    }
  });

  it('accepts the 6 MiB boundary and rejects one byte over before forwarding', async () => {
    const { url, requests } = await setup('application/json');
    for (const extra of [0, 1]) {
      const text = JSON.stringify({ padding: 'a'.repeat(6 * 1024 * 1024 - 14 + extra) });
      expect(Buffer.byteLength(text)).toBe(6 * 1024 * 1024 + extra);
      const response = await fetch(`${url}/api/native/render/frames`, { method: 'POST', body: text });
      expect(response.status).toBe(extra ? 413 : 200);
      await response.arrayBuffer();
    }
    expect(requests).toHaveLength(1);
    const reset = await fetch(`${url}/api/native/render/reset`, { method: 'POST', body: JSON.stringify({ session: 'a'.repeat(4096) }) });
    expect(reset.status).toBe(413);
    await reset.arrayBuffer();
    expect(requests).toHaveLength(1);
  });
});
