'use strict';

/**
 * pnpm hook (read automatically by `pnpm install`): keeps compile-time and
 * test-time optional peers out of the production dependency graph. pnpm
 * resolves an optional peer to a matching dev dependency and records it as a
 * dependency of the declaring package, so `pnpm install --prod` (Docker
 * image) installs it although no production code loads it:
 * - `@nestjs/swagger` declares `typescript` for its CLI plugin, which this
 *   service does not use (TypeScript, about 24 MB);
 * - `@darmawanweb/ais-its-nest` declares `testcontainers` and
 *   `@nestjs/testing` for its `./testing` subpath, which only the tests
 *   import (testcontainers with dockerode, ssh2 and their native addons).
 * The tests still resolve both from this repository's dev dependencies.
 */
const UNUSED_OPTIONAL_PEERS = {
  '@nestjs/swagger': ['typescript'],
  '@darmawanweb/ais-its-nest': ['testcontainers', '@nestjs/testing'],
};

/** `record` without the keys in `names`. */
function without(record, names) {
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );
}

function readPackage(manifest) {
  const peers = UNUSED_OPTIONAL_PEERS[manifest.name];
  if (peers === undefined) return manifest;
  return {
    ...manifest,
    peerDependencies: without(manifest.peerDependencies, peers),
    peerDependenciesMeta: without(manifest.peerDependenciesMeta, peers),
  };
}

module.exports = { hooks: { readPackage } };
