import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMaxWorkers } from '../../../vitest.shared';

/**
 * Guard on the CI worker budget (`VITEST_MAX_WORKERS`, resolved in vitest.shared.ts).
 *
 * vitest reads that same env var itself and applies it with a bare `Number.parseInt`, overriding
 * the config. Before vitest.shared.ts normalized it, CI's `'25%'` meant 25 forks per package on a
 * 4-vCPU runner - one mongod per real-Mongo file - and the multi-package legs failed on "Hook
 * timed out" in suites unrelated to the change under test. Nothing errors when that regresses, it
 * just flakes, so the end-to-end check below asks vitest itself what it resolved.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI_WORKFLOW = path.resolve(PACKAGE_ROOT, '../../.github/workflows/ci.yml');

describe('resolveMaxWorkers', () => {
  it('leaves the budget unset when the env var is empty', () => {
    expect(resolveMaxWorkers(undefined, 4)).toBeUndefined();
    expect(resolveMaxWorkers('', 4)).toBeUndefined();
    expect(resolveMaxWorkers('  ', 4)).toBeUndefined();
  });

  it('keeps an absolute count as-is', () => {
    expect(resolveMaxWorkers('2', 4)).toBe(2);
    expect(resolveMaxWorkers(' 3 ', 64)).toBe(3);
  });

  it('turns a percentage into a share of the cores, clamped to [1, cores]', () => {
    expect(resolveMaxWorkers('25%', 4)).toBe(1);
    expect(resolveMaxWorkers('50%', 4)).toBe(2);
    expect(resolveMaxWorkers('25%', 64)).toBe(16);
    expect(resolveMaxWorkers('1%', 4)).toBe(1);
    expect(resolveMaxWorkers('400%', 4)).toBe(4);
  });

  it.each(['0', '-1', '2.5', '25 %', '25.5%', 'abc', '0x4'])('rejects the malformed value %j', value => {
    expect(() => resolveMaxWorkers(value, 4)).toThrow(/Malformed VITEST_MAX_WORKERS/);
  });
});

describe('the budget vitest actually runs with', () => {
  // A subprocess, because vitest reads the env var while resolving its config: loading this
  // package's real config is the only way to observe the value that wins.
  const resolvedByVitest = (budget: string): unknown => {
    const script = [
      "import { createVitest } from 'vitest/node';",
      "const vitest = await createVitest('test', { watch: false }, {});",
      'process.stdout.write(JSON.stringify(vitest.config.maxWorkers));',
      'await vitest.close();',
    ].join('\n');
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, VITEST_MAX_WORKERS: budget },
      encoding: 'utf8',
    });
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null');
  };

  it('is the share of the cores a percentage asks for, not the percentage read as a count', () => {
    expect(resolvedByVitest('25%')).toBe(resolveMaxWorkers('25%', availableParallelism()));
  });
});

describe('ci.yml test-shard worker budgets', () => {
  const contents = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const workers = [...contents.matchAll(/^\s*workers:\s*'([^']*)'\s*$/gm)].map(match => match[1]);

  // Each package's vitest sizes its pool to the whole runner, so two packages at once is two
  // pools on the same cores. A per-package cap is no substitute: pnpm runs dependents last, so the
  // heaviest packages end up alone on a pool capped at a fraction of the box.
  it('runs one package at a time in every leg', () => {
    const runLines = contents.split('\n').filter(line => /^\s*pnpm --recursive\b.*"\$SHARD_SCRIPT"/.test(line));
    expect(runLines, 'the sharded test command was not found - has the step moved?').toHaveLength(1);
    expect(runLines[0]).toMatch(/--workspace-concurrency=1\s/);
  });

  it('declares a budget on the matrix legs', () => {
    expect(workers, 'no `workers:` values found in ci.yml - has the matrix shape moved?').not.toHaveLength(0);
  });

  it('declares only budgets that resolve', () => {
    for (const value of workers) {
      expect(() => resolveMaxWorkers(value, 4), `workers: '${value}'`).not.toThrow();
    }
  });
});
