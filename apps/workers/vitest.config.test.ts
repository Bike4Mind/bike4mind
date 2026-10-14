import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the lane-conditional `retry` gate in vitest.config.mts. `retry` only changes behaviour on
 * a failing test, so nothing else would notice it widening into the unit lane. Same shape as
 * apps/client/vitest.config.test.ts: ask vitest itself what it resolved.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// A subprocess, because WORKERS_TEST_LANE is read while resolving vitest.config.mts.
const resolvedRetry = (workersTestLane: string | undefined): unknown => {
  const script = [
    "import { createVitest } from 'vitest/node';",
    "const vitest = await createVitest('test', { watch: false }, {});",
    'process.stdout.write(JSON.stringify({ retry: vitest.config.retry }));',
    'await vitest.close();',
  ].join('\n');
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, WORKERS_TEST_LANE: workersTestLane ?? '' },
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}').retry;
};

describe('the workers-integration lane retry gate', () => {
  it('retries in the integration lane', () => {
    expect(resolvedRetry('integration')).toBe(2);
  });

  it('does not retry in the unit lane', () => {
    expect(resolvedRetry(undefined)).toBeFalsy();
  });
});
