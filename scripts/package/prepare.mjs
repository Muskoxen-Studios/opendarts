#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stage a self-contained app directory for electron-builder.
 *
 * Why this exists: the repo is an npm workspace whose backend runs TypeScript
 * directly, and electron-builder wants a single self-contained app root. This
 * assembles one at `build/app` -- backend sources, the built frontend, the
 * third-party dependencies, and a real Node runtime -- without changing how
 * the project is laid out or introducing a build step for the backend.
 *
 * Run it before electron-builder:
 *   node scripts/package/prepare.mjs
 *   npx electron-builder --publish never
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(REPO, 'build', 'app');

/** The packages the backend needs at runtime. The frontend ships as `dist`. */
const BACKEND_PACKAGES = ['schema', 'engine', 'stats', 'bridge', 'server', 'fakeboard'];

/**
 * Third-party runtime dependencies, flattened out of the workspace.
 *
 * Listed here rather than derived, so that adding a dependency to a backend
 * package is a deliberate decision about what ships in the installer.
 */
const RUNTIME_DEPENDENCIES = { ws: '^8.18.0', zod: '^3.24.1', 'electron-updater': '^6.3.9' };

const log = (...args) => console.log('[prepare]', ...args);

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: REPO, shell: process.platform === 'win32', ...options });
}

// -- the Node runtime that will execute the backend --------------------------

/**
 * Which Node to bundle.
 *
 * The packaged app carries its own rather than using Electron's embedded Node:
 * the backend needs type stripping and `node:sqlite`, and Electron's Node line
 * lags. Pinned to a major, resolved to the newest release of it at build time,
 * so a build is reproducible enough to debug but never pins a version that has
 * been pulled.
 */
const NODE_MAJOR = process.env.DARTS_NODE_MAJOR ?? '24';

async function resolveNodeVersion() {
  if (process.env.DARTS_NODE_VERSION) return process.env.DARTS_NODE_VERSION;

  const res = await fetch('https://nodejs.org/dist/index.json');
  if (!res.ok) throw new Error(`could not list Node releases: ${res.status}`);
  const releases = await res.json();

  const match = releases.find((r) => r.version.startsWith(`v${NODE_MAJOR}.`));
  if (!match) throw new Error(`no Node ${NODE_MAJOR}.x release found`);
  return match.version;
}

function runtimeArchive(version) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') {
    return { name: `node-${version}-win-${arch}.zip`, binary: ['node.exe'], target: ['node.exe'] };
  }
  if (process.platform === 'darwin') {
    return { name: `node-${version}-darwin-${arch}.tar.gz`, binary: ['bin', 'node'], target: ['bin', 'node'] };
  }
  return { name: `node-${version}-linux-${arch}.tar.xz`, binary: ['bin', 'node'], target: ['bin', 'node'] };
}

/**
 * Download the runtime and check it against Node's own SHASUMS256.txt.
 *
 * The check is the point: this binary is about to be signed into an installer
 * and shipped, so "it downloaded something" is not good enough.
 */
async function fetchRuntime(version) {
  const { name, binary, target } = runtimeArchive(version);
  const base = `https://nodejs.org/dist/${version}`;
  const work = await mkdtemp(join(tmpdir(), 'darts-node-'));
  const archive = join(work, name);

  log(`downloading ${name}`);
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`could not download ${name}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));

  const sumsRes = await fetch(`${base}/SHASUMS256.txt`);
  if (!sumsRes.ok) throw new Error(`could not download SHASUMS256.txt: ${sumsRes.status}`);
  const sums = await sumsRes.text();

  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`${name} is not listed in SHASUMS256.txt`);

  const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${name}\n  expected ${expected}\n  got      ${actual}`);
  }
  log(`checksum ok (${expected.slice(0, 16)}…)`);

  // Windows 10+ ships bsdtar as tar.exe, which reads zips too -- so one
  // command covers every platform and nothing has to be vendored to unpack.
  run('tar', ['-xf', archive, '-C', work], { cwd: work, stdio: 'ignore' });

  const extracted = (await readdir(work, { withFileTypes: true })).find(
    (e) => e.isDirectory() && e.name.startsWith('node-'),
  );
  if (!extracted) throw new Error('the Node archive did not contain the expected directory');

  const from = join(work, extracted.name, ...binary);
  const to = join(OUT, 'runtime', ...target);
  await mkdir(dirname(to), { recursive: true });
  // Only the binary: it is self-contained, and the rest of the tarball is npm
  // and headers, which would be tens of megabytes of nothing in the installer.
  await copyFile(from, to);
  await chmod(to, 0o755);
  await rm(work, { recursive: true, force: true });
  log(`runtime staged at runtime/${target.join('/')}`);
}

// -- staging -----------------------------------------------------------------

async function stage() {
  log(`staging into ${OUT}`);
  await rm(join(REPO, 'build'), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  log('building the frontend');
  run('npm', ['run', 'build']);

  const rootManifest = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
  const desktopManifest = JSON.parse(await readFile(join(REPO, 'packages/desktop/package.json'), 'utf8'));

  /*
   * The staged root is itself a workspace.
   *
   * That is not incidental: `@darts/*` has to resolve through symlinks rather
   * than copies, because Node refuses to type-strip anything whose real path
   * is inside node_modules. `npm install` on a workspace produces exactly
   * those symlinks (junctions on Windows), which is why this leans on npm
   * instead of laying out node_modules by hand.
   */
  await writeFile(
    join(OUT, 'package.json'),
    JSON.stringify(
      {
        name: 'darts',
        productName: 'Darts',
        version: process.env.DARTS_VERSION ?? desktopManifest.version,
        description: desktopManifest.description,
        author: 'Muskoxen Studios',
        private: true,
        type: 'module',
        main: 'src/main.js',
        workspaces: ['packages/*'],
        dependencies: RUNTIME_DEPENDENCIES,
        engines: rootManifest.engines,
      },
      null,
      2,
    ) + '\n',
  );

  // The shell itself. CommonJS, so it needs its own type marker under a
  // "type": "module" root.
  await cp(join(REPO, 'packages/desktop/src'), join(OUT, 'src'), { recursive: true });
  await writeFile(join(OUT, 'src', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

  for (const name of BACKEND_PACKAGES) {
    const from = join(REPO, 'packages', name);
    const to = join(OUT, 'packages', name);
    await mkdir(to, { recursive: true });
    await cp(join(from, 'package.json'), join(to, 'package.json'));
    // Tests are not shipped: they pull in vitest and testkits that are not
    // installed in the staged tree, and they are dead weight in an installer.
    await cp(join(from, 'src'), join(to, 'src'), {
      recursive: true,
      filter: (path) => !path.endsWith('.test.ts'),
    });
  }

  await cp(join(REPO, 'packages/frontend/dist'), join(OUT, 'packages/frontend/dist'), { recursive: true });
  /*
   * electron-builder is run with --projectDir build/app, so its config has to
   * be in there with it -- plus the Electron version, which it would otherwise
   * work out by resolving `electron` from the project.
   *
   * It cannot: the staged app deliberately does not depend on Electron. The
   * shell is `require`-ing APIs that the Electron runtime provides, not a
   * package it installs, and shipping a second copy of Electron inside the
   * app it is already running under would be absurd. So the version is read
   * from the repo's own devDependency and written in.
   */
  const electronVersion = JSON.parse(
    await readFile(join(REPO, 'node_modules/electron/package.json'), 'utf8'),
  ).version;

  // electron-builder takes the app icon from `build/icon.png` inside the
  // project directory, which is the staged tree -- so it has to be put there.
  // Regenerate it with scripts/package/icon.mjs.
  await mkdir(join(OUT, 'build'), { recursive: true });
  await copyFile(join(REPO, 'build-resources', 'icon.png'), join(OUT, 'build', 'icon.png'));

  const builderConfig = await readFile(join(REPO, 'electron-builder.yml'), 'utf8');
  await writeFile(
    join(OUT, 'electron-builder.yml'),
    `${builderConfig}\n# Written by scripts/package/prepare.mjs; see the comment there.\nelectronVersion: ${electronVersion}\n`,
  );
  log(`packaging against Electron ${electronVersion}`);
  log(`staged ${BACKEND_PACKAGES.length} backend packages and the built frontend`);

  log('installing runtime dependencies');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: OUT });
}

// -- a check that the result actually runs -----------------------------------

/**
 * Prove the staged tree resolves and type-strips before it is ever packaged.
 *
 * This is the failure this script exists to prevent: `@darts/*` resolving to a
 * copy inside node_modules rather than a symlink, which Node refuses to
 * type-strip. It fails at startup, in an installer, on someone else's machine.
 */
async function verify(version) {
  const node =
    process.platform === 'win32'
      ? join(OUT, 'runtime', 'node.exe')
      : join(OUT, 'runtime', 'bin', 'node');

  const probe = join(OUT, 'probe.mjs');
  await writeFile(
    probe,
    [
      "const { segmentValue } = await import('@darts/schema');",
      "const { toRawCoords } = await import('@darts/fakeboard');",
      "if (segmentValue({ number: 20, ring: 'TRIPLE' }) !== 60) throw new Error('engine maths is wrong');",
      "if (toRawCoords({ number: 20, ring: 'TRIPLE' }).y <= 0) throw new Error('20 is not at the top');",
      "console.log('ok');",
    ].join('\n'),
  );

  try {
    execFileSync(node, [probe], { cwd: OUT, stdio: 'pipe' });
    log(`verified: the staged tree runs on bundled Node ${version}`);
  } catch (err) {
    throw new Error(
      `the staged tree does not run on the bundled runtime.\n${err.stderr ?? err.stdout ?? err}`,
    );
  } finally {
    await rm(probe, { force: true });
  }
}

const version = await resolveNodeVersion();
log(`bundling Node ${version} for ${process.platform}-${process.arch}`);
await stage();
await fetchRuntime(version);
await verify(version);
log('done — now run: npx electron-builder --projectDir build/app --publish never');
