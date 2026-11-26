import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Runs the real "Report CI result" script of ci.yml's ci-complete job (the required
// "CI Complete" check) against job results, so the pass/fail rule is tested as shipped.
type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
const step = ci.jobs['ci-complete']?.steps?.find(s => s.name === 'Report CI result');
const resultVars = Object.keys(step?.env ?? {}).filter(name => name !== 'DEPLOYABLE');

function run(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', DEPLOYABLE: 'true' };
  for (const name of resultVars) env[name] = 'success';
  return spawnSync('bash', ['-c', step!.run!], { env: { ...env, ...overrides }, encoding: 'utf8' });
}

describe('ci-complete result rule', () => {
  it('finds the step and its job results', () => {
    expect(step?.run).toBeTruthy();
    expect(resultVars.length).toBeGreaterThan(10);
  });

  it('passes when every leg succeeded', () => {
    expect(run().status).toBe(0);
  });

  it('passes when a non-shard leg was skipped', () => {
    expect(run({ CLI_E2E: 'skipped', VERIFY_DOCS: 'skipped' }).status).toBe(0);
  });

  it.each(resultVars)('fails when %s failed', name => {
    expect(run({ [name]: 'failure' }).status).toBe(1);
  });

  // A leg that hits its timeout-minutes ends `cancelled` while the run itself is not cancelled.
  it.each(resultVars)('fails when %s timed out (cancelled)', name => {
    const res = run({ [name]: 'cancelled' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('::error::');
  });
});
