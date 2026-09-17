#!/usr/bin/env node

// Fails when a root pnpm.overrides pin contradicts a range a package in the
// installed tree declares. pnpm applies an override silently: the package still
// resolves, nothing warns, and the mismatch first surfaces much later as a
// missing export while bundling.
//
// Only plain-name override keys are checked. The "name@range" selector form
// (e.g. "axios@<1.18.0") is conditional on purpose -- it rewrites the versions
// inside the selector and leaves every other version alone -- so a package
// declaring a range outside the selector is not a contradiction.
//
// The check is per edge, not per package name: an override written as a range
// can leave several versions in the tree, so the only sound question is which
// version a given dependent actually resolved to. That answer lives in the
// installed tree, because the lockfile records resolved versions and never the
// ranges packages declare.
//
// Usage: pnpm install --frozen-lockfile && node scripts/check-pnpm-overrides.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const virtualStore = join(repoRoot, 'node_modules', '.pnpm');
const MAX_DEPENDENTS_SHOWN = 5;

// "@scope/name" is plain; "@scope/name@<1.2.3" and "name@<1.2.3" are selectors.
export function isPlainNameKey(key) {
  const afterScope = key.startsWith('@') ? key.slice(key.indexOf('/') + 1) : key;
  return afterScope.length > 0 && !afterScope.includes('@');
}

// A virtual-store directory is "<name with / written as +>@<version>", with an
// optional "(peer)(peer)" or "(patch_hash=...)" suffix.
export function storeDirPackageName(dir) {
  const base = dir.includes('(') ? dir.slice(0, dir.indexOf('(')) : dir;
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  return base.slice(0, at).replaceAll('+', '/');
}

function readManifest(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// One edge per (dependent, overridden dependency) pair: what the dependent asked
// for, and what pnpm materialized next to it.
export function collectEdges(storePath, overrideKeys) {
  const keys = new Set(overrideKeys);
  const edges = [];

  for (const entry of readdirSync(storePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const ownName = storeDirPackageName(entry.name);
    if (!ownName) continue;

    const depsRoot = join(storePath, entry.name, 'node_modules');
    const manifest = readManifest(join(depsRoot, ...ownName.split('/'), 'package.json'));
    if (!manifest?.name) continue;

    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!keys.has(dep)) continue;
      // Aliases, workspace links and git specs are not ranges an override can contradict.
      if (!semver.validRange(range, { loose: true })) continue;

      const resolved = readManifest(join(depsRoot, ...dep.split('/'), 'package.json'))?.version;
      if (!resolved) continue;

      edges.push({
        dependent: manifest.version ? `${manifest.name}@${manifest.version}` : manifest.name,
        dep,
        range,
        resolved,
      });
    }
  }

  return edges;
}

export function findViolations(edges) {
  const violations = new Map();

  for (const edge of edges) {
    if (semver.satisfies(edge.resolved, edge.range, { loose: true })) continue;

    if (!violations.has(edge.dep)) violations.set(edge.dep, new Map());
    const byRange = violations.get(edge.dep);
    if (!byRange.has(edge.range)) byRange.set(edge.range, { dependents: [], resolved: new Set() });

    const group = byRange.get(edge.range);
    group.dependents.push(edge.dependent);
    group.resolved.add(edge.resolved);
  }

  return violations;
}

function report(violations, overrides) {
  const lines = ['ERROR: pnpm.overrides contradicts ranges declared in the installed tree.', ''];

  for (const [dep, byRange] of [...violations].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${dep}, pinned by pnpm.overrides to "${overrides[dep]}":`);
    for (const [range, group] of [...byRange].sort(([a], [b]) => a.localeCompare(b))) {
      const shown = [...new Set(group.dependents)].sort();
      const extra = shown.length - MAX_DEPENDENTS_SHOWN;
      const dependents = shown.slice(0, MAX_DEPENDENTS_SHOWN).join(', ');
      const suffix = extra > 0 ? `, and ${extra} more` : '';
      const got = [...group.resolved].sort(semver.compare).join(', ');
      lines.push(`    declared ${range}, resolved ${got}: ${dependents}${suffix}`);
    }
    lines.push('');
  }

  lines.push('Raise each override to a range that satisfies every declared floor, or drop it.');
  lines.push('A pin below a declared floor installs without a warning and fails later at bundle time.');
  console.error(lines.join('\n'));
}

function main() {
  const overrides = readManifest(join(repoRoot, 'package.json'))?.pnpm?.overrides ?? {};
  const overrideKeys = Object.keys(overrides).filter(isPlainNameKey);

  if (!existsSync(virtualStore)) {
    console.error(`ERROR: ${virtualStore} not found. Run pnpm install before this check.`);
    process.exit(1);
  }

  const edges = collectEdges(virtualStore, overrideKeys);
  // Fail closed: an empty edge set means the tree is missing, not that it agrees.
  if (overrideKeys.length > 0 && edges.length === 0) {
    console.error(`ERROR: no dependents of ${overrideKeys.join(', ')} found under ${virtualStore}.`);
    console.error('The installed tree looks incomplete. Re-run pnpm install.');
    process.exit(1);
  }

  const violations = findViolations(edges);
  if (violations.size > 0) {
    report(violations, overrides);
    process.exit(1);
  }

  console.log(`OK: ${edges.length} dependency edges agree with ${overrideKeys.length} pnpm.overrides pins.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
