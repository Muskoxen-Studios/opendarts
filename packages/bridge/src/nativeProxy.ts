import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SourceConfig } from './sourceConfig.ts';
import { NativeSimThrowSchema, NativeSimTakeoutSchema, NativeSimResetSchema, nativeRequest } from './nativeControl.ts';
import { describeFetchError } from './fetchError.ts';
import { MAX_RENDER_BODY, renderBody } from './nativeRender.ts';

/** Explicit allowlist: this is not an arbitrary detector URL proxy. */
export async function nativeProxy(
  req: IncomingMessage,
  res: ServerResponse,
  config: SourceConfig,
  body?: unknown,
): Promise<boolean> {
  const path = req.url ?? '';
  const frame = /^\/native\/cameras\/([a-zA-Z0-9_-]+)\/frame$/.test(path);
  const get = req.method === 'GET' && (path === '/native/state' || path === '/native/health' || frame);
  const post = req.method === 'POST' && [
      '/native/sim/throw', '/native/sim/takeout', '/native/sim/reset',
      '/native/render/configure', '/native/render/frames', '/native/render/reset',
    ].includes(path);
  if (!get && !post) return false;
  const json = (code: number, value: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(value));
  };
  if (config.kind !== 'native') {
    json(409, { ok: false, error: 'native detector is not the active source' });
    return true;
  }
  let payload: unknown;
  if (post && path.startsWith('/native/render/')) {
    if (Buffer.byteLength(JSON.stringify(body) ?? '') > (path.endsWith('/reset') ? 4096 : MAX_RENDER_BODY)) {
      json(413, { ok: false, error: path.endsWith('/reset') ? 'render reset body exceeds 4096 bytes' : 'render body exceeds 6 MiB' });
      return true;
    }
    const parsed = renderBody(path, body);
    if (!parsed.success) {
      json(400, { ok: false, error: 'invalid rendered camera payload; only calibration and grayscale frames are accepted' });
      return true;
    }
    payload = parsed.data;
  } else if (path === '/native/sim/throw') {
    const parsed = NativeSimThrowSchema.safeParse(body);
    if (!parsed.success) {
      json(400, { error: 'expected { x_mm, y_mm } with finite millimetre coordinates; segments are not accepted' });
      return true;
    }
    payload = parsed.data;
  } else if (post) {
    const schema = path === '/native/sim/takeout' ? NativeSimTakeoutSchema : NativeSimResetSchema;
    const parsed = schema.safeParse(body === undefined ? {} : body);
    if (!parsed.success) {
      json(400, { error: 'expected an empty reset body or takeout { count?: positive integer }' });
      return true;
    }
    payload = parsed.data;
  }
  try {
    const upstream = await nativeRequest(config.url, path.slice('/native'.length), req.method, payload);
    if (frame && upstream.ok && !upstream.headers.get('content-type')?.startsWith('image/')) {
      await upstream.body?.cancel();
      json(502, { error: 'detector camera did not return an image' });
      return true;
    }
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
    } else res.end();
  } catch (err) {
    if (res.headersSent) res.destroy();
    else json(502, { ok: false, error: describeFetchError(err, config.url) });
  }
  return true;
}
