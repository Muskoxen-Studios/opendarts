'use strict';

const { relinkDartsPackages } = require('./relink.cjs');
const { join } = require('node:path');

/**
 * Put the `@darts/*` scope back after electron-builder has packed the app.
 *
 * electron-builder prunes node_modules to the production dependencies it can
 * see in package.json, and the workspace packages are not among them -- so it
 * deletes them, and `import '@darts/schema'` fails on the user's machine.
 *
 * The rebuilding is re-export shims rather than links, for a reason worth
 * reading before changing it: see scripts/package/relink.cjs.
 *
 * This runs before the NSIS/AppImage step, so what it writes is what ships.
 */
exports.default = async function afterPack(context) {
  const appDir = join(context.appOutDir, 'resources', 'app');
  const names = await relinkDartsPackages(appDir);
  console.log(`  • relinked @darts/{${names.join(',')}} for ${context.packager.platform.name}`);
};
