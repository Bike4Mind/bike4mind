import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the lane-conditional `retry`, `include` and `exclude` gates in vitest.config.mts. `retry`
 * only changes behaviour on a failing test, and a lane that stops excluding or including the
 * `*.e2e.test.ts` suites would still go green, so nothing else would notice. Same shape as
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
});
