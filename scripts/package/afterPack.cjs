'use strict';

const { mkdir, readdir, symlink } = require('node:fs/promises');
const { join } = require('node:path');

/**
 * Put the `@darts/*` links back after electron-builder has packed the app.
 *
 * electron-builder prunes node_modules to the production dependencies it can
 * see in package.json, and the workspace links are not among them -- so it
 * deletes them, and `import '@darts/schema'` fails on the user's machine.
 *
 * They have to be **links**, not copies: Node refuses to type-strip TypeScript
 * whose real path is inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_
 * STRIPPING), and the backend ships as TypeScript. A link resolves to a real
 * path under `packages/`, which strips fine. That is the whole reason this
 * hook exists rather than a copy step.
 *
 * The link target is relative so it survives being installed anywhere, and on
 * Windows it is a junction, which -- unlike a symlink -- needs no privileges.
 */
exports.default = async function afterPack(context) {
  const appDir = join(context.appOutDir, 'resources', 'app');
  const packagesDir = join(appDir, 'packages');
  const scope = join(appDir, 'node_modules', '@darts');

  await mkdir(scope, { recursive: true });

  const entries = await readdir(packagesDir, { withFileTypes: true });
  const type = context.packager.platform.name === 'windows' ? 'junction' : 'dir';

  for (const entry of entries) {
    // `frontend` is a built `dist`, not an importable package.
    if (!entry.isDirectory() || entry.name === 'frontend') continue;
    await symlink(join('..', '..', 'packages', entry.name), join(scope, entry.name), type);
  }

  console.log(`  • relinked @darts/* for ${context.packager.platform.name}`);
};
