'use strict';

const { createServer } = require('node:net');
const { existsSync } = require('node:fs');
const { networkInterfaces } = require('node:os');
const { join } = require('node:path');

/**
 * Locating the things the shell needs to start the backend, and nothing else.
 *
 * Split out from main.js so it can be reasoned about (and run) without booting
 * Electron: every function here is a plain lookup over the filesystem or the
 * network stack.
 */

/**
 * The Node binary that runs the backend.
 *
 * The packaged app carries its own Node 24 rather than using Electron's
 * embedded one. Two reasons, both hard requirements: the backend is TypeScript
 * executed directly by type stripping, and it stores data through
 * `node:sqlite`. Electron's Node is an older line with neither guaranteed, and
 * discovering that at a customer's install is not a good time.
 *
 * In development there is no bundled runtime, so it falls back to whatever
 * `node` is on PATH -- which is the Node 24 the repo already requires.
 */
function findNodeRuntime(appRoot) {
  if (process.env.DARTS_NODE) return process.env.DARTS_NODE;

  const candidates =
    process.platform === 'win32'
      ? [join(appRoot, 'runtime', 'node.exe')]
      : [join(appRoot, 'runtime', 'bin', 'node'), join(appRoot, 'runtime', 'node')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

/**
 * A port nothing else is on.
 *
 * Asked for rather than assumed, because a compose stack or a second copy of
 * the app may already hold 8080/8081, and "the app silently shows someone
 * else's scoreboard" is a much worse failure than moving to another port.
 *
 * There is an unavoidable race between closing the probe and the child
 * binding, but the alternative -- handing the child an inherited socket --
 * would mean the backend could no longer be run on its own from a terminal.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Addresses another device on the same network can reach the scoreboard on. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * Wait for the server to answer, or explain why it never did.
 *
 * Polls a real endpoint rather than the TCP port: the port is listening well
 * before the database is open and the bridge is connected, and loading the
 * window early shows a broken scoreboard for a second.
 */
async function waitForServer(url, { timeoutMs = 30000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
      lastError = new Error(`answered ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`the game server did not start within ${timeoutMs / 1000}s: ${lastError}`);
}

module.exports = { findNodeRuntime, findFreePort, lanAddresses, waitForServer };
