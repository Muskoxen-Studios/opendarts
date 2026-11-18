#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createCaptureReviewHandler } from '../packages/server/src/captureReview.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.CAPTURE_REVIEW_PORT ?? 8092);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CAPTURE_REVIEW_PORT');
const directory = resolve(process.env.BOARD_CAPTURE_DIR ?? resolve(root, 'data/board-captures'));
const handleCaptures = await createCaptureReviewHandler({ directory });
let vite;
const server = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (await handleCaptures(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown review API route' }));
      return;
    }
    if (url.pathname === '/') req.url = `/review.html${url.search}`;
    vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); });
  } catch (error) {
    console.error('[capture-review]', error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Capture review request failed' }));
  }
});
vite = await createViteServer({
  configFile: false,
  root: resolve(root, 'packages/frontend'),
  plugins: [vue()],
  appType: 'mpa',
  server: { middlewareMode: true, hmr: { server }, host: '127.0.0.1' },
});
server.on('error', error => {
  console.error(`[capture-review] ${error.message}; choose another CAPTURE_REVIEW_PORT if needed`);
  void vite.close().finally(() => process.exit(1));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[capture-review] http://127.0.0.1:${port}  captures=${directory}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close();
  void vite.close().finally(() => process.exit(0));
});
