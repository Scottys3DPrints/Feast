/**
 * @feast/core — shared types and pure logic. NO I/O, ever.
 *
 * Depends on `zod` and nothing else (§5). Both the Expo app and the Node CLI import
 * from here, so anything that touches the filesystem, the network, or a native module
 * belongs in `packages/storage`, `apps/ingest`, or `apps/mobile` instead.
 */

export * from './types';
export * from './codec';
export * from './schema';
export * from './speakers';
export * from './paths';
export * from './ids';
