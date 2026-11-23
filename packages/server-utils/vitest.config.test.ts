import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the lane-conditional `retry`, `include` and `exclude` gates in vitest.config.mts. `retry`
 * only changes behaviour on a failing test, and a lane that stops excluding or including the
 * `*.e2e.test.ts` or `*.repo.test.*` suites would still go green, so nothing else would notice. Same shape as
 * apps/client/vitest.config.test.ts: ask vitest itself what it resolved.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// A subprocess, because SERVER_UTILS_TEST_LANE is read while resolving vitest.config.mts.
const resolvedLane = (
  serverUtilsTestLane: string | undefined
): { retry: unknown; include: string[]; exclude: string[] } => {
  const script = [
    "import { createVitest } from 'vitest/node';",
    "const vitest = await createVitest('test', { watch: false }, {});",
    'process.stdout.write(JSON.stringify({ retry: vitest.config.retry, include: vitest.config.include, exclude: vitest.config.exclude }));',
    'await vitest.close();',
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, SERVER_UTILS_TEST_LANE: serverUtilsTestLane ?? '' },
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
};

const VITEST_BIN = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

// Package-relative paths of the files vitest collects in a lane.
const collectedFiles = (serverUtilsTestLane: string | undefined): string[] => {
  const stdout = execFileSync(process.execPath, [VITEST_BIN, 'list', '--filesOnly', '--json'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, SERVER_UTILS_TEST_LANE: serverUtilsTestLane ?? '' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries: unknown = JSON.parse(stdout.slice(stdout.search(/^\[\s*(?:[{\]]|$)/m)));
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
describe('the server-utils test lanes', () => {
  it('collects every *.repo.test.* file in the repo lane and nowhere else', { timeout: 60_000 }, () => {
    const repoFiles = packageFilesMatching(/\.repo\.test\.[cm]?[jt]sx?$/);
    const e2eFiles = packageFilesMatching(/\.e2e\.test\.ts$/);
    expect(repoFiles.length).toBeGreaterThan(0);
    expect(collectedFiles('repo')).toEqual(repoFiles);
    expect(collectedFiles('integration')).toEqual(e2eFiles);
    const unit = new Set(collectedFiles(undefined));
    expect(unit.size).toBeGreaterThan(400);
    expect([...repoFiles, ...e2eFiles].filter(file => unit.has(file))).toEqual([]);
  });
});

describe('the server-utils-integration lane gates', () => {
  it('retries in the integration lane', () => {
    expect(resolvedLane('integration').retry).toBe(2);
  });

  it('does not retry in the unit lane', () => {
    expect(resolvedLane(undefined).retry).toBeFalsy();
  });

  it('keeps the real-Mongo suites out of the unit lane', () => {
    expect(resolvedLane(undefined).exclude).toContain('**/*.e2e.test.ts');
  });

  it('runs only the real-Mongo suites in the integration lane', () => {
    expect(resolvedLane('integration').include).toEqual(['**/*.e2e.test.ts']);
  });

  it('keeps the repo-scan suites out of the unit and integration lanes', () => {
    expect(resolvedLane(undefined).exclude).toContain('**/*.repo.test.?(c|m)[jt]s?(x)');
    expect(resolvedLane('integration').exclude).toContain('**/*.repo.test.?(c|m)[jt]s?(x)');
  });

  it('runs only the repo-scan suites in the repo lane', () => {
    expect(resolvedLane('repo').include).toEqual(['**/*.repo.test.?(c|m)[jt]s?(x)']);
    expect(resolvedLane('repo').retry).toBeFalsy();
  });
});
