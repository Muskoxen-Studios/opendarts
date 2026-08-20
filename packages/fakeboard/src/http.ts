import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FakeBoard } from './board.ts';
import { CAM_IDS, FPS, motionStateFrame, RESOLUTION, statsFrame } from './frames.ts';

export const BOARD_VERSION = '1.0.7';

/**
 * Note what is deliberately absent: a `Cf-Ray` header. On the real board,
 * `/api/*` is served locally and carries no Cloudflare headers, while unknown
 * paths fall through to the cloud-proxied SPA and do (FINDINGS §4). That header
 * is the recon scripts' only reliable "is this endpoint real?" signal, so the
 * fake must never grow one.
 */
export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function text(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(body);
}

/** Mirrors this board's real configuration (FINDINGS §6). */
function configBody() {
  return {
    cams: CAM_IDS.map((id) => ({ id, resolution: RESOLUTION, fps: FPS })),
    detection: { autoStart: false, autoCalibrate: true, motionStandbyMinutes: 15 },
    auth: { api_key: '' },
    version: BOARD_VERSION,
  };
}

/**
 * Returns true if it handled the request.
 *
 * Only the endpoints the app actually calls are implemented. Everything else
 * 404s rather than returning a plausible-looking body, so a typo in a board
 * path fails here the same way it would fail against real hardware.
 */
export function handleApi(req: IncomingMessage, res: ServerResponse, board: FakeBoard): boolean {
  const url = (req.url ?? '').split('?')[0] ?? '';
  if (!url.startsWith('/api')) return false;
  const method = req.method ?? 'GET';

  // A plain GET here gets 400 on the real board; only an upgrade succeeds.
  // Requests that *are* upgrades never reach this handler.
  if (url === '/api/events') {
    text(res, 400, 'Bad Request');
    return true;
  }

  if (url === '/api/ping' && method === 'GET') {
    text(res, 200, 'pong');
    return true;
  }
  if (url === '/api/version' && method === 'GET') {
    text(res, 200, BOARD_VERSION);
    return true;
  }

  if (url === '/api/start' && method === 'PUT') {
    board.start();
    json(res, 200, board.snapshot());
    return true;
  }
  if (url === '/api/stop' && method === 'PUT') {
    board.stop();
    json(res, 200, board.snapshot());
    return true;
  }
  if (url === '/api/reset' && method === 'POST') {
    board.reset();
    json(res, 200, board.snapshot());
    return true;
  }
  if (url === '/api/config/calibration/auto' && method === 'POST') {
    board.calibrate();
    json(res, 200, board.snapshot());
    return true;
  }
  if ((url === '/api/streams/start' || url === '/api/streams/stop') && method === 'PUT') {
    // Accepted and ignored: there are no cameras behind this board, and the
    // real endpoint only toggles streaming, never detection.
    json(res, 200, { ok: true });
    return true;
  }

  if (url === '/api/state' && method === 'GET') {
    json(res, 200, board.snapshot());
    return true;
  }
  if (url === '/api/state/dump' && method === 'GET') {
    json(res, 200, { state: board.snapshot(), config: configBody() });
    return true;
  }
  if (url === '/api/state/stats' && method === 'GET') {
    json(res, 200, statsFrame());
    return true;
  }
  if (url === '/api/state/motion' && method === 'GET') {
    json(res, 200, motionStateFrame(0));
    return true;
  }
  if (url === '/api/cams/stats' && method === 'GET') {
    json(res, 200, CAM_IDS.map((id) => ({ id, fps: FPS, resolution: RESOLUTION })));
    return true;
  }
  if (url === '/api/config' && method === 'GET') {
    json(res, 200, configBody());
    return true;
  }

  // MJPEG. Pretending to serve video would be worse than refusing: a caller
  // would hang waiting for frames that never come.
  if (url.startsWith('/api/streams') || url.startsWith('/api/img')) {
    json(res, 501, { error: 'the fake board has no cameras' });
    return true;
  }

  json(res, 404, { error: `no such board endpoint: ${method} ${url}` });
  return true;
}
