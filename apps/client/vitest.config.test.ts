import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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
