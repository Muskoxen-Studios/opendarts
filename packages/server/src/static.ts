import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Serving the built frontend from the game server itself.
 *
 * Under docker compose nginx does this and none of it runs. The desktop app
 * has no nginx, and serving the scoreboard from the same origin as the API is
 * what lets the frontend keep using relative `/api` and `/ws` urls in both
 * worlds rather than needing to know where it is deployed.
 *
 * Its own module because of `serveStatic`'s containment check: this server
 * binds to the LAN, so "can a crafted path read outside the web root" is a
 * question that deserves a test rather than a comment.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticFile {
  path: string;
  size: number;
  contentType: string;
  /** Hashed asset names are immutable; index.html never is. */
  cacheControl: string;
}

/**
 * Resolve a request path to a file inside `webRoot`, or null.
 *
 * An unknown path resolves to `index.html`, because it is a client-side route
 * rather than a missing file -- that is what makes this a single-page app.
 * `/api/*` is excluded: it has already had its chance at the router and must
 * keep answering with a JSON 404, not an HTML page.
 */
export async function resolveStatic(webRoot: string, pathname: string): Promise<StaticFile | null> {
  if (pathname.startsWith('/api/')) return null;

  const root = resolve(webRoot);
  const index = join(root, 'index.html');

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path; fall through to the app shell.
    decoded = '/';
  }

  // normalize() resolves `..`, but the result can still land outside the root
  // (`/../../etc/passwd`), so the containment check is the thing that matters.
  const requested = join(root, normalize(decoded));
  const contained = requested === root || requested.startsWith(root + sep);

  for (const candidate of contained ? [requested, index] : [index]) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return {
        path: candidate,
        size: info.size,
        contentType: MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        cacheControl: candidate === index ? 'no-cache' : 'public, max-age=31536000, immutable',
      };
    } catch {
      // Missing or unreadable -- try the app shell, then give up.
    }
  }
  return null;
}

/** Write a resolved file out. Split from resolution so resolution is testable. */
export function sendStatic(res: ServerResponse, file: StaticFile, headOnly: boolean): void {
  res.writeHead(200, {
    'content-type': file.contentType,
    'content-length': file.size,
    'cache-control': file.cacheControl,
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(file.path).pipe(res);
}
