import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the lane-conditional `retry` gate in vitest.config.mts (`projectTest`, near line 85).
 *
 * `retry` only changes behaviour on a failing test, so CI stays green whether the
 * `INTEGRATION_LANE` guard is present or not - a later edit that moves `retry: 2` into
 * `sharedTest`, or drops the guard on `projectTest`, would silently start retrying the unit lane
 * and mask genuine unit failures with nothing else to catch it. This asks vitest itself what it
 * resolved, the same end-to-end shape as `packages/scripts/src/vitestWorkerBudget.test.ts`.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// A subprocess, because CLIENT_TEST_LANE is read while resolving vitest.config.mts: loading the
// real config is the only way to observe which lane's `retry` value wins. Reading process.env
// directly from this test file would not do it either way - the jsdom project's
// `define: { 'process.env': {} }` rewrites it inside a transformed test module.
const resolvedRetryByProject = (clientTestLane: string | undefined): Record<string, unknown> => {
  const script = [
    "import { createVitest } from 'vitest/node';",
    "const vitest = await createVitest('test', { watch: false }, {});",
    'const retries = Object.fromEntries(vitest.projects.map(p => [p.name, p.config.retry]));',
    'process.stdout.write(JSON.stringify(retries));',
    'await vitest.close();',
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, CLIENT_TEST_LANE: clientTestLane ?? '' },
    encoding: 'utf8',
  });
  // JSON drops a key whose value is `undefined` rather than writing `null`, which is exactly the
  // "not set" case below - and a dropped key reads back as `undefined` on access either way, so
  // this round-trip cannot turn a real 2 into a false negative or vice versa.
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
};

const VITEST_BIN = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

// Package-relative paths of the files vitest collects in a lane, across both projects.
const collectedFiles = (clientTestLane: string | undefined): string[] => {
  const stdout = execFileSync(process.execPath, [VITEST_BIN, 'list', '--filesOnly', '--json'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, CLIENT_TEST_LANE: clientTestLane ?? '' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries: unknown = JSON.parse(stdout.slice(stdout.indexOf('[')));
  if (!Array.isArray(entries)) throw new Error('vitest list --json did not print an array');
  return entries.map(entry => path.relative(PACKAGE_ROOT, (entry as { file: string }).file)).sort();
};

// An fs walk rather than `git ls-files`: this file runs in the cached unit lane, where the guard in
// scripts/__tests__/turbo-test-cache.test.mjs forbids git scans. Skips the dirs vitest never collects.
const packageFiles = (directory: string = PACKAGE_ROOT): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? packageFiles(fullPath) : [path.relative(PACKAGE_ROOT, fullPath)];
  });

const packageFilesMatching = (pattern: RegExp): string[] =>
  packageFiles()
    .filter(file => pattern.test(file))
    .sort();

// Pairs with REPO_LANE_FILE in scripts/__tests__/turbo-test-cache.test.mjs: a file the guard treats
// as uncached must never be collected by a cached lane, and each lane must keep its own files.
describe('the client test lanes', () => {
  it('collects every *.repo.test.* file in the repo lane and nowhere else', { timeout: 60_000 }, () => {
    const repoFiles = packageFilesMatching(/\.repo\.test\.[cm]?[jt]sx?$/);
    const e2eFiles = packageFilesMatching(/\.e2e\.test\.ts$/);
    expect(repoFiles.length).toBeGreaterThan(0);
    expect(collectedFiles('repo')).toEqual(repoFiles);
    expect(collectedFiles('integration')).toEqual(e2eFiles);
    const unit = new Set(collectedFiles(undefined));
    expect(unit.size).toBeGreaterThan(1000);
    expect([...repoFiles, ...e2eFiles].filter(file => unit.has(file))).toEqual([]);
  });
});

describe('the client-integration lane retry gate', () => {
  it('retries both projects only in the integration lane', () => {
    const retries = resolvedRetryByProject('integration');
    expect(Object.keys(retries).sort()).toEqual(['jsdom', 'node']);
    expect(retries.node).toBe(2);
    expect(retries.jsdom).toBe(2);
  });

  it('retries neither project in the unit lane', () => {
    const retries = resolvedRetryByProject(undefined);
    expect(retries.node).toBeUndefined();
    expect(retries.jsdom).toBeUndefined();
  });
});
