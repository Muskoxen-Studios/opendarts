import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Three 720p grayscale base64 images plus bounded calibration/JSON overhead.
export const MAX_RENDER_BODY = 6 * 1024 * 1024;

/** Keep previews same-origin without exposing an arbitrary upstream proxy. */
export async function proxyNative(
  req: IncomingMessage,
  res: ServerResponse,
  bridgeUrl: string,
  body?: unknown,
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const get = req.method === 'GET' && (
    path === '/api/native/health' || path === '/api/native/state' ||
    /^\/api\/native\/cameras\/[a-zA-Z0-9_-]+\/frame$/.test(path)
  );
  const post = req.method === 'POST' && [
    '/api/native/sim/throw', '/api/native/sim/takeout', '/api/native/sim/reset',
    '/api/native/render/configure', '/api/native/render/frames', '/api/native/render/reset',
  ].includes(path);
  const json = (code: number, value: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(value));
  };
  if (!get && !post) {
    json(404, { ok: false, error: 'unknown native detector route' });
    return;
  }
  if (post && path.startsWith('/api/native/render/') && Buffer.byteLength(JSON.stringify(body) ?? '') > (path.endsWith('/reset') ? 4096 : MAX_RENDER_BODY)) {
    json(413, { ok: false, error: path.endsWith('/reset') ? 'render reset body exceeds 4096 bytes' : 'render body exceeds 6 MiB' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const cancel = (): void => { if (!res.writableFinished) controller.abort(); };
  res.on('close', cancel);
  try {
    const upstream = await fetch(`${bridgeUrl.replace(/\/+$/, '')}${path.slice('/api'.length)}`, {
      method: req.method,
      signal: controller.signal,
      ...(post ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    });
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    if (get && path.endsWith('/frame') && upstream.ok && !contentType.startsWith('image/')) {
      await upstream.body?.cancel();
      json(502, { ok: false, error: 'detector camera did not return an image' });
      return;
    }
    res.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
    } else res.end();
  } catch (err) {
    if (res.headersSent) res.destroy();
    else json(502, { ok: false, error: `bridge unreachable: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    clearTimeout(timer);
    res.off('close', cancel);
  }
}
