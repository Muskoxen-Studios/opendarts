import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStatic } from './static.ts';

/**
 * The web root the desktop app serves from, plus a secret next to it that a
 * crafted path must never reach.
 */
let root: string;
let outside: string;

beforeAll(async () => {
  outside = await mkdtemp(join(tmpdir(), 'darts-static-'));
  root = join(outside, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>darts</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(outside, 'secret.txt'), 'not for the network');
});

afterAll(async () => {
  await rm(outside, { recursive: true, force: true });
});

describe('serving the built scoreboard', () => {
  it('serves a real asset with its own content type', async () => {
    const file = await resolveStatic(root, '/assets/app.js');
    expect(file?.path).toBe(join(root, 'assets', 'app.js'));
    expect(file?.contentType).toContain('text/javascript');
  });

  it('falls back to the app shell for a client-side route', async () => {
    const file = await resolveStatic(root, '/leaderboard');
    expect(file?.path).toBe(join(root, 'index.html'));
    expect(file?.contentType).toContain('text/html');
  });

  it('serves the shell at the root', async () => {
    expect((await resolveStatic(root, '/'))?.path).toBe(join(root, 'index.html'));
  });

  /*
   * The API must keep answering as an API. Falling back to index.html here
   * would turn every mistyped endpoint into a 200 with an HTML body, which the
   * frontend would then try to parse as JSON.
   */
  it('never answers for an API path', async () => {
    expect(await resolveStatic(root, '/api/nonsense')).toBeNull();
  });

  /*
   * This server binds to the LAN, so escaping the web root is a real exposure
   * and not a theoretical one. Every one of these must land on the shell.
   */
  it('cannot be walked out of the web root', async () => {
    for (const attempt of [
      '/../secret.txt',
      '/../../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
    ]) {
      const file = await resolveStatic(root, attempt);
      expect(file?.path, `${attempt} escaped the web root`).toBe(join(root, 'index.html'));
    }
  });

  it('survives a malformed percent escape', async () => {
    expect((await resolveStatic(root, '/%zz'))?.path).toBe(join(root, 'index.html'));
  });

  it('lets the shell be re-fetched but pins hashed assets', async () => {
    expect((await resolveStatic(root, '/'))?.cacheControl).toBe('no-cache');
    expect((await resolveStatic(root, '/assets/app.js'))?.cacheControl).toContain('immutable');
  });

  it('does not serve a directory as though it were a file', async () => {
    expect((await resolveStatic(root, '/assets'))?.path).toBe(join(root, 'index.html'));
  });
});
