#!/usr/bin/env node
// Keeps mcp-registry/server.json's version in step with @bike4mind/cli.
//
// WHY THIS IS A SCRIPT AND NOT A CONVENTION: the registry entry must name a
// version that actually exists on npm, and mcpRegistryEntry.test.ts enforces
// that it equals the package version. changesets bumps packages/cli/package.json
// and knows nothing about mcp-registry/, so without this the two diverge on every
// CLI release - and because the release runs as one shared "version packages" PR
// batching every pending changeset in the monorepo, that red test would hold the
// merge queue for unrelated packages until someone hand-edited a bot-generated
// branch. Chaining this into `changeset:version` makes the bump automatic instead.
//
// Idempotent, and a no-op when the versions already agree.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(repoRoot, 'packages/cli/package.json');
const serverPath = resolve(repoRoot, 'mcp-registry/server.json');

const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const server = JSON.parse(readFileSync(serverPath, 'utf8'));

if (server.version === version && server.packages?.[0]?.version === version) {
  console.log(`mcp-registry/server.json already at ${version}`);
  process.exit(0);
}

const previous = server.version;
server.version = version;
if (server.packages?.[0]) server.packages[0].version = version;
writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(`mcp-registry/server.json ${previous} -> ${version}`);
