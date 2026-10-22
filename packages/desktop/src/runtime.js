'use strict';

const { createServer } = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { networkInterfaces } = require('node:os');
const { join } = require('node:path');

/**
 * Runtime discovery and child-process lifecycle, without Electron dependencies.
 * Split out from main.js so startup and teardown can be tested without a GUI.
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
async function waitForServer(url, {
  timeoutMs = 30000, intervalMs = 150, name = 'game server', getFailure = () => null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const failure = getFailure();
    if (failure) throw failure;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) });
      await res.body?.cancel();
      if (getFailure()) throw getFailure();
      if (res.ok) return true;
      lastError = new Error(`answered ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (getFailure()) throw getFailure();
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(intervalMs, deadline - Date.now()))));
  }
  throw new Error(`the ${name} did not start within ${timeoutMs / 1000}s: ${lastError}`);
}

function findPythonRuntime(appRoot, { env = process.env, platform = process.platform } = {}) {
  if (env.DETECTOR_PYTHON) return { executable: env.DETECTOR_PYTHON, args: [] };
  const local = platform === 'win32'
    ? join(appRoot, '.venv', 'Scripts', 'python.exe')
    : join(appRoot, '.venv', 'bin', 'python');
  if (existsSync(local)) return { executable: local, args: [] };
  return platform === 'win32'
    ? { executable: 'py', args: ['-3'] }
    : { executable: 'python3', args: [] };
}

function checkPythonRuntime(runtime) {
  const result = spawnSync(runtime.executable, [...runtime.args, '-c',
    'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
  { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Native detector requires Python 3.10+. Could not run ${runtime.executable}: ${result.error || result.stderr || 'unsupported Python version'}. Install Python or set DETECTOR_PYTHON to its executable; use DARTS_DETECTOR=off to disable automatic startup.`);
  }
}

async function detectorConfig(appRoot, { isPackaged = false, env = process.env, platform = process.platform } = {}) {
  if (env.DETECTOR_URL) return { url: env.DETECTOR_URL, managed: false };
  if (isPackaged || env.DARTS_DETECTOR === 'off') return null;
  const runtime = findPythonRuntime(appRoot, { env, platform });
  checkPythonRuntime(runtime);
  const entry = join(appRoot, 'services', 'detector', 'main.py');
  if (!existsSync(entry)) throw new Error(`Native detector entry point is missing: ${entry}. Restore the source checkout or set DARTS_DETECTOR=off.`);
  const port = await findFreePort();
  return {
    url: `http://127.0.0.1:${port}`, managed: true,
    executable: runtime.executable,
    args: [...runtime.args, '-u', entry, '--source', 'rendered', '--port', String(port)],
  };
}

/** Shared process supervision for Node and Python, with a bounded diagnostic tail. */
function startChild(executable, args, { cwd, env = {}, name, onFailure = () => {}, log = console.log }) {
  const child = spawn(executable, args, {
    cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const state = { child, name, failure: null, stopping: false };
  const tail = [];
  const remember = (buf) => {
    const text = String(buf).trimEnd().slice(-4096);
    if (text) log(`[${name}] ${text}`);
    tail.push(text);
    if (tail.length > 20) tail.shift();
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  const fail = (message) => {
    if (state.stopping || state.failure) return;
    state.failure = new Error(`${message}\n\n${tail.join('\n')}`);
    onFailure(state.failure);
  };
  child.on('error', (err) => fail(`Could not start ${name}: ${err.message}`));
  child.on('exit', (code, signal) => {
    log(`[${name}] exited (code ${code}, signal ${signal})`);
    fail(`The ${name} process stopped (code ${code}, signal ${signal}).`);
  });
  return state;
}

function stopChild(state, { graceMs = 2000 } = {}) {
  state.stopping = true;
  const { child } = state;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      child.kill('SIGTERM');
    }
    timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, graceMs);
  });
}

module.exports = {
  findNodeRuntime, findFreePort, lanAddresses, waitForServer,
  findPythonRuntime, checkPythonRuntime, detectorConfig, startChild, stopChild,
};
