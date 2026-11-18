import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  const calibrationFrame = /^\/native\/calibration\/frame\/cam[0-2]$/.test(path);
  const get = req.method === 'GET' && (path === '/native/state' || path === '/native/health' || path === '/native/usb/devices' || frame || calibrationFrame);
  const post = req.method === 'POST' && [
      '/native/sim/throw', '/native/sim/takeout', '/native/sim/reset',
      '/native/render/configure', '/native/render/frames', '/native/render/reset',
      '/native/calibration/freeze', '/native/calibration/apply',
      '/native/usb/connect', '/native/usb/disconnect',
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
  } else if (post && path.startsWith('/native/usb/')) {
    const schema = path.endsWith('/connect') ? z.object({ devices: z.array(z.string().min(1).max(512)).length(3) }).strict() : z.object({}).strict();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { json(400, { error: 'invalid USB camera request' }); return true; }
    payload = parsed.data;
  } else if (post && path.startsWith('/native/calibration/')) {
    const point = z.tuple([z.number().finite().nonnegative().max(1280), z.number().finite().nonnegative().max(720)]);
    const keys = z.object({ cam0: z.array(point).length(9), cam1: z.array(point).length(9), cam2: z.array(point).length(9) }).strict();
    const schema = path.endsWith('/freeze') ? z.object({}).strict() : z.object({ token: z.string().regex(/^[a-f0-9]{32}$/), landmarks: keys }).strict();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { json(400, { ok: false, error: 'invalid calibration request' }); return true; }
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
    const upstream = await nativeRequest(config.url, path.slice('/native'.length), req.method, payload, path === '/native/usb/connect' ? 55000 : 4000);
    if ((frame || calibrationFrame) && upstream.ok && !upstream.headers.get('content-type')?.startsWith('image/')) {
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
      // Read through the web reader directly. A Node Readable adapter can emit
      // a delayed unhandled error when fetch aborts during proxy teardown.
      const reader = upstream.body.getReader();
      await pipeline((async function* () {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })(), res);
    } else res.end();
  } catch (err) {
    if (res.headersSent) res.destroy();
    else json(502, { ok: false, error: describeFetchError(err, config.url) });
  }
  return true;
}
