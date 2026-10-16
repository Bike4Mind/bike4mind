#!/usr/bin/env node
/**
 * Declare every hydrated premium overlay as a workspace dependency of apps/client.
 *
 * pnpm links a workspace package only where a package.json depends on it, and the
 * generated glue imports overlays by bare specifier from apps/client. A hydrated but
 * undeclared overlay is therefore left unwired (see generate-premium-glue.mjs).
 *
 * Rewrites apps/client/package.json in place, so run it only in a throwaway tree such as
 * the self-host image build. Committing the result would break every open-core install.
 * No-op when packages/premium/ holds no overlay.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREMIUM_DIR = path.join(ROOT, 'packages/premium');
const CLIENT_MANIFEST = path.join(ROOT, 'apps/client/package.json');

function overlayNames() {
  if (!existsSync(PREMIUM_DIR)) return [];
  const names = new Set();
  for (const entry of readdirSync(PREMIUM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(PREMIUM_DIR, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    // Same filter the glue codegen applies: only a package that contributes is an overlay.
    if (pkg.name && pkg.b4mContributions) names.add(pkg.name);
  }
  return [...names].sort();
}

const names = overlayNames();
if (names.length === 0) {
  console.log('[link-premium-overlays] no overlay hydrated - nothing to link');
  process.exit(0);
}

const client = JSON.parse(readFileSync(CLIENT_MANIFEST, 'utf8'));
client.dependencies = client.dependencies ?? {};
for (const name of names) client.dependencies[name] = 'workspace:*';
writeFileSync(CLIENT_MANIFEST, `${JSON.stringify(client, null, 2)}\n`);
console.log(`[link-premium-overlays] linked ${names.length} overlay(s) into apps/client: ${names.join(', ')}`);
