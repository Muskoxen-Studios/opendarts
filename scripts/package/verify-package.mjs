#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Check that the *packed* app runs somewhere other than this repository.
 *
 * The "somewhere else" is the entire point. Node resolves bare specifiers by
 * walking up parent directories, so a packed app sitting under the repo will
 * happily find `@darts/*` in the repo's own workspace node_modules and appear
 * to work -- while the same tree on a user's machine cannot resolve a thing.
 * That exact false positive nearly shipped a broken installer once; this exists
 * so it cannot happen quietly again.
 *
 * Run after electron-builder:
 *   node scripts/package/verify-package.mjs
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE = join(REPO, 'build', 'release');

const log = (...args) => console.log('[verify]', ...args);

/** The unpacked app directory electron-builder leaves next to the installer. */
async function findPackedApp() {
  const entries = await readdir(RELEASE, { withFileTypes: true }).catch(() => []);
  const unpacked = entries.find((e) => e.isDirectory() && e.name.endsWith('unpacked'));
  if (!unpacked) {
    throw new Error(`no *-unpacked directory in ${RELEASE} -- run electron-builder first`);
  }

  return process.platform === 'darwin'
    ? join(RELEASE, unpacked.name)
    : join(RELEASE, unpacked.name, 'resources', 'app');
}

const packed = await findPackedApp();
const away = await mkdtemp(join(tmpdir(), 'darts-verify-'));
const app = join(away, 'app');

log(`copying the packed app somewhere with no workspace above it: ${app}`);
/*
 * Deliberately dereferencing, not `verbatimSymlinks`.
 *
 * The Windows installer archives the packed app with 7z and unpacks it on the
 * user's machine, and that round trip turns any link into a copy of its
 * target. Copying the same way here means this check reproduces it: anything
 * that only works while a link is a link fails locally instead of shipping.
 */
await cp(packed, app, { recursive: true, dereference: true });

const node = process.platform === 'win32' ? join(app, 'runtime', 'node.exe') : join(app, 'runtime', 'bin', 'node');

const probe = join(app, 'verify-probe.mjs');
await writeFile(
  probe,
  [
    // Resolution through the rebuilt @darts/* scope, and type stripping of a
    // file reached through it: the two things packaging breaks.
    "const { segmentValue } = await import('@darts/schema');",
    "const { toRawCoords } = await import('@darts/fakeboard');",
    "const { engineFor } = await import('@darts/engine');",
    "if (segmentValue({ number: 20, ring: 'TRIPLE' }) !== 60) throw new Error('scoring is wrong');",
    "if (toRawCoords({ number: 20, ring: 'TRIPLE' }).y <= 0) throw new Error('20 is not at the top');",
    "if (typeof engineFor('x01') !== 'object') throw new Error('the engine did not load');",
    "console.log('ok');",
  ].join('\n'),
);

try {
  execFileSync(node, [probe], { cwd: app, stdio: 'pipe' });
  log('the packed app resolves and runs its own backend outside the repo');
  const detector = join(app, 'runtime', 'detector', process.platform === 'win32' ? 'darts-detector.exe' : 'darts-detector');
  const frame = join(away, 'camera.pgm');
  await writeFile(frame, Buffer.concat([Buffer.from('P5\n1280 720\n255\n'), Buffer.alloc(1280 * 720, 180)]));
  const manifest = join(away, 'frames.json');
  await writeFile(manifest, JSON.stringify([{ cam0: 'camera.pgm', cam1: 'camera.pgm', cam2: 'camera.pgm' }]));
  const selfTest = execFileSync(detector, ['--source', 'usb', '--camera-config', join(away, 'rig.json'),
    '--mock-cameras', manifest, '--self-test'], { cwd: away, encoding: 'utf8', timeout: 60000 });
  if (!selfTest.includes('v6 self-test ok bc5b45538ae8d4308874b910f870aa11d4171ccba500dc2739a4694b045a1588')) {
    throw new Error('bundled detector inference self-test failed');
  }
  const probePort = await new Promise((resolvePort, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
  });
  const child = spawn(detector, ['--source', 'usb', '--camera-config', join(away, 'rig.json'),
    '--mock-cameras', manifest, '--port', String(probePort)], { cwd: away, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', (data) => { diagnostic += data.toString(); });
  try {
    const deadline = Date.now() + 45000;
    let state;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`detector exited: ${diagnostic}`);
      try {
        const response = await fetch(`http://127.0.0.1:${probePort}/state`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { state = await response.json(); break; }
      } catch { /* process is starting */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if (state?.source !== 'usb' || state?.model?.sha256 !== 'bc5b45538ae8d4308874b910f870aa11d4171ccba500dc2739a4694b045a1588') {
      throw new Error(`bundled model did not load: ${diagnostic}`);
    }
    log('the packed detector loads its bundled v6 model and mock cameras');
  } finally {
    child.kill();
    await new Promise((resolveExit) => { if (child.exitCode !== null) resolveExit(); else child.once('exit', resolveExit); });
  }
} catch (err) {
  const detail = String(err.stderr ?? err.stdout ?? err);
  throw new Error(
    `the packed app does not run.\n\n${detail}\n\n` +
      `If this is ERR_MODULE_NOT_FOUND, electron-builder pruned the @darts/* scope again ` +
      `and scripts/package/afterPack.cjs did not put it back. If it is ` +
      `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, something inside node_modules/@darts is ` +
      `a copy of a package rather than a shim re-exporting one from packages/.`,
  );
} finally {
  await rm(away, { recursive: true, force: true });
}
