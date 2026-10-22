'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createServer } = require('node:http');
const {
  findPythonRuntime, checkPythonRuntime, detectorConfig,
  findFreePort, startChild, stopChild, waitForServer,
} = require('./runtime.js');

const root = resolve(__dirname, '../../..');
const quiet = () => {};
function nodeChild(code, onFailure = quiet) {
  return startChild(process.execPath, ['-e', code], {
    cwd: root, name: 'test child', log: quiet, onFailure,
  });
}

test('Python discovery: explicit executable, project venv, platform fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'darts-python-'));
  try {
    assert.deepEqual(findPythonRuntime(dir, { env: { DETECTOR_PYTHON: '/custom/python' } }),
      { executable: '/custom/python', args: [] });
    assert.deepEqual(findPythonRuntime(dir, { env: {}, platform: 'linux' }),
      { executable: 'python3', args: [] });
    assert.deepEqual(findPythonRuntime(dir, { env: {}, platform: 'win32' }),
      { executable: 'py', args: ['-3'] });
    mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'bin', 'python'), '');
    writeFileSync(join(dir, '.venv', 'Scripts', 'python.exe'), '');
    assert.equal(findPythonRuntime(dir, { env: {}, platform: 'linux' }).executable,
      join(dir, '.venv', 'bin', 'python'));
    assert.equal(findPythonRuntime(dir, { env: {}, platform: 'win32' }).executable,
      join(dir, '.venv', 'Scripts', 'python.exe'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing Python gives an actionable startup error', () => {
  assert.throws(() => checkPythonRuntime({ executable: join(root, 'no-such-python'), args: [] }),
    /Python 3\.10\+.*DETECTOR_PYTHON.*DARTS_DETECTOR=off/s);
});

test('external URL and opt-out never discover or spawn Python; packaged never auto-starts', async () => {
  const env = { DETECTOR_PYTHON: '/missing/python' };
  assert.equal(await detectorConfig(root, { env, isPackaged: true }), null);
  assert.equal(await detectorConfig(root, { env: { ...env, DARTS_DETECTOR: 'off' } }), null);
  for (const isPackaged of [true, false]) {
    assert.deepEqual(await detectorConfig(root, {
      isPackaged, env: { ...env, DETECTOR_URL: 'https://example.test/detector', DARTS_DETECTOR: 'off' },
    }), { url: 'https://example.test/detector', managed: false });
  }
});

test('development plan uses a dynamic loopback URL and rendered mode', async () => {
  const config = await detectorConfig(root, { env: {} });
  assert.equal(config.managed, true);
  const url = new URL(config.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0);
  assert.deepEqual(config.args.slice(-5), [join(root, 'services/detector/main.py'),
    '--source', 'rendered', '--port', url.port]);
});

test('spawn errors are observed rather than unhandled', async () => {
  let failure;
  const state = startChild(join(root, 'no-such-executable'), [], {
    cwd: root, name: 'missing executable', log: quiet, onFailure: (err) => { failure = err; },
  });
  await assert.rejects(waitForServer('http://127.0.0.1:1/health', {
    timeoutMs: 1000, intervalMs: 10, getFailure: () => state.failure,
  }), /Could not start missing executable/);
  assert.equal(failure, state.failure);
  await stopChild(state);
});

test('even a clean unexpected exit fails readiness with diagnostic output', async () => {
  const state = nodeChild('console.error("detector configuration failed");');
  try {
    await assert.rejects(waitForServer('http://127.0.0.1:1/health', {
      timeoutMs: 1000, intervalMs: 10, getFailure: () => state.failure,
    }), /process stopped \(code 0.*detector configuration failed/s);
  } finally {
    await stopChild(state);
  }
});

test('readiness has a bounded timeout even when a server never responds', async () => {
  const sockets = new Set();
  const server = createServer(() => {});
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const start = Date.now();
  try {
    await assert.rejects(waitForServer(`http://127.0.0.1:${server.address().port}/health`, {
      timeoutMs: 100, intervalMs: 10, name: 'native detector',
    }), /native detector did not start within/);
    assert.ok(Date.now() - start < 1000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('teardown escalates a child ignoring SIGTERM and suppresses failure callbacks', {
  skip: process.platform === 'win32', timeout: 5000,
}, async () => {
  let failures = 0;
  const state = nodeChild('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
    () => { failures += 1; });
  try {
    await new Promise((r) => state.child.stdout.once('data', r));
    await stopChild(state, { graceMs: 50 });
    if (state.child.signalCode === null) await new Promise((r) => state.child.once('exit', r));
    assert.equal(state.child.signalCode, 'SIGKILL');
    assert.equal(failures, 0);
  } finally {
    await stopChild(state, { graceMs: 50 });
  }
});

for (const source of ['synthetic', 'rendered']) {
  test(`real Python ${source} detector becomes healthy without renderer frames and shuts down`, {
    timeout: 15000,
  }, async () => {
    const runtime = findPythonRuntime(root);
    checkPythonRuntime(runtime);
    const port = await findFreePort();
    const url = `http://127.0.0.1:${port}`;
    const state = startChild(runtime.executable, [...runtime.args, '-u',
      join(root, 'services/detector/main.py'), '--source', source, '--port', String(port)], {
      cwd: root, name: 'real detector', log: quiet, env: { PYTHONDONTWRITEBYTECODE: '1' },
    });
    try {
      await waitForServer(`${url}/health`, { timeoutMs: 10000, name: 'native detector', getFailure: () => state.failure });
      const health = await (await fetch(`${url}/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(typeof health.session, 'string');
      const snapshot = await (await fetch(`${url}/state`)).json();
      assert.equal(snapshot.source, source);
      await stopChild(state);
      assert.ok(state.child.exitCode !== null || state.child.signalCode !== null);
      assert.equal(state.failure, null);
      await assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }));
    } finally {
      await stopChild(state);
    }
  });
}