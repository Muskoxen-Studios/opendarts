#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

/**
 * Cut a release: bump every workspace to one version, commit, tag, push.
 *
 * The tag is what actually releases -- `.github/workflows/release.yml` builds
 * the installers on `push: tags: ['v*']` -- so this script exists to make the
 * versions in the tree and the version in the tag impossible to disagree about.
 *
 *   npm run release -- patch          # 0.1.1 -> 0.1.2   (default)
 *   npm run release -- minor|major
 *   npm run release -- 1.4.0          # explicit version
 *   npm run release -- patch --dry-run    # print what would happen, touch nothing
 *   npm run release -- patch --no-push    # commit and tag locally only
 *   npm run release -- patch --skip-checks
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(REPO, 'packages');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const dryRun = has('--dry-run') || has('-n');
const push = !has('--no-push') && !dryRun;
const skipChecks = has('--skip-checks');
const bumpArg = args.find((a) => !a.startsWith('-')) ?? 'patch';

const log = (...a) => console.log('[release]', ...a);
const die = (message) => {
  console.error(`[release] ${message}`);
  process.exit(1);
};

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: REPO, encoding: 'utf8' }).trim();
}

function run(command, cmdArgs) {
  if (dryRun) return log(`would run: ${command} ${cmdArgs.join(' ')}`);
  execFileSync(command, cmdArgs, { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
}

// -- which version -----------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The current version is read from the tree, not from `git tag`: the tree is
 * what ships, and a tag that was pushed from another checkout should not
 * silently become the base for the next bump.
 */
function currentVersion() {
  const manifests = manifestPaths().map(readManifest);
  const versions = [...new Set(manifests.map((m) => m.json.version).filter(Boolean))];
  if (versions.length === 0) die('no package in the workspace declares a version');
  if (versions.length > 1) {
    log(`warning: workspace versions disagree (${versions.join(', ')}); bumping from the highest`);
  }
  return versions.sort(compareVersions).at(-1);
}

function compareVersions(a, b) {
  const [, ...x] = SEMVER.exec(a) ?? die(`not a semver version: ${a}`);
  const [, ...y] = SEMVER.exec(b) ?? die(`not a semver version: ${b}`);
  return x.map(Number).reduce((acc, n, i) => acc || n - Number(y[i]), 0);
}

function nextVersion(from, bump) {
  if (SEMVER.test(bump)) return bump;
  const match = SEMVER.exec(from) ?? die(`current version is not semver: ${from}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return die(`unknown bump "${bump}" -- expected major, minor, patch or an explicit x.y.z`);
}

// -- the manifests -----------------------------------------------------------

function manifestPaths() {
  const workspaces = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES, entry.name, 'package.json'));
  return [join(REPO, 'package.json'), ...workspaces];
}

function readManifest(path) {
  return { path, json: JSON.parse(readFileSync(path, 'utf8')) };
}

/**
 * Rewritten with a regex rather than `JSON.stringify`, so that a version bump
 * never reformats a manifest or reorders its keys -- the diff of a release
 * commit should be one line per package and nothing else.
 */
function setVersion(path, version) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
  if (updated === source) die(`could not find a "version" field to bump in ${relative(REPO, path)}`);
  if (!dryRun) writeFileSync(path, updated);
  return updated !== source;
}

// -- go ----------------------------------------------------------------------

if (git('rev-parse', '--is-inside-work-tree') !== 'true') die('not a git repository');

const dirty = git('status', '--porcelain');
if (dirty) {
  const message = `working tree is not clean:\n${dirty}`;
  if (dryRun) log(`warning: ${message}`);
  else die(`${message}\n\nCommit or stash first -- a release commit should contain only the version bump.`);
}

const from = currentVersion();
const version = nextVersion(from, bumpArg);
const tag = `v${version}`;
log(`${from} -> ${version}${dryRun ? ' (dry run)' : ''}`);

if (git('tag', '--list', tag)) die(`tag ${tag} already exists`);

if (skipChecks) log('skipping npm run check');
else run('npm', ['run', 'check']);

for (const path of manifestPaths()) {
  setVersion(path, version);
  log(`${relative(REPO, path)} -> ${version}`);
}

// The lockfile carries each workspace's version too; refresh it so the release
// commit does not leave `npm ci` reinstalling a stale tree.
run('npm', ['install', '--package-lock-only', '--ignore-scripts']);

run('git', ['add', '-A']);
run('git', ['commit', '-m', `release ${tag}`]);
run('git', ['tag', '-a', tag, '-m', `release ${tag}`]);

if (!push) {
  log(dryRun ? 'dry run: nothing was changed' : `not pushing. When ready: git push origin HEAD && git push origin ${tag}`);
} else {
  run('git', ['push', 'origin', 'HEAD']);
  run('git', ['push', 'origin', tag]);
  log(`pushed ${tag} -- the release workflow builds the installers from it`);
}
