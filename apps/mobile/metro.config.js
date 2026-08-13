const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro config for a pnpm monorepo.
 *
 * Two settings are required rather than optional here:
 *   • `watchFolders` must include the repo root, or Metro will not see edits to
 *     `packages/core` and `packages/storage` — they are consumed as TypeScript source
 *     (`main: ./src/index.ts`), not as built output.
 *   • `nodeModulesPaths` must list both the app's and the root's node_modules, because
 *     `.npmrc` sets `node-linker=hoisted` and shared deps land at the root.
 */

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Prevent Metro resolving two copies of React when a workspace package pulls its own.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
