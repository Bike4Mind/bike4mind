import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readJobs, readNeeds } from './ciWorkflowText';

/**
 * Guard on the shard assertion inside ci.yml's required `ci-complete` check. It needs `test-shards`
 * directly rather than the `test` aggregator, and its result loop only reddens on a literal
 * `failure`, so the dedicated `DEPLOYABLE && TEST_SHARDS != success` block is the one thing keeping
 * unit tests gating merges. Dropping the need, the env mapping or that block would quietly ungate
 * them with nothing turning red.
 *
 * Text-matched like checkDocsScanGateWired.test.ts; the last describe runs the helpers over a broken
 * copy so a parser that stops seeing the wiring fails instead of passing vacuously.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const jobBody = (source: string, name: string) => readJobs(source).find(job => job.name === name)?.body ?? '';

function readEnvVar(body: string, expression: string): string | undefined {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`^\\s+([A-Z][A-Z0-9_]*):\\s*\\$\\{\\{\\s*${escaped}\\s*\\}\\}\\s*$`, 'm').exec(body)?.[1];
}

function assertsShardsSucceeded(body: string, deployableVar: string, shardsVar: string): boolean {
  return new RegExp(
    `^\\s*if \\[ "\\$${deployableVar}" = "true" \\] && \\[ "\\$${shardsVar}" != "success" \\]; then\\s*\\n\\s*.*\\n\\s*exit 1\\s*$`,
    'm'
  ).test(body);
}

describe('test-shards gate in the required ci-complete check', () => {
  const ciComplete = jobBody(ci, 'ci-complete');

  it('exists', () => {
    expect(ciComplete, 'ci.yml has no ci-complete job').not.toBe('');
  });

  it('needs test-shards and changes', () => {
    expect(readNeeds(ciComplete)).toEqual(expect.arrayContaining(['test-shards', 'changes']));
  });

  it('fails a deployable run whose shards did not all succeed', () => {
    const shardsVar = readEnvVar(ciComplete, 'needs.test-shards.result');
    const deployableVar = readEnvVar(ciComplete, 'needs.changes.outputs.deployable');
    expect(shardsVar, 'ci-complete does not map needs.test-shards.result into its env').toBeDefined();
    expect(deployableVar, 'ci-complete does not map needs.changes.outputs.deployable into its env').toBeDefined();
    expect(
      assertsShardsSucceeded(ciComplete, deployableVar!, shardsVar!),
      `ci-complete has no "$${deployableVar} = true && $${shardsVar} != success -> exit 1" block`
    ).toBe(true);
  });
});

describe('the test-shards gate check rejects a broken workflow', () => {
  it('sees the shard assertion removed', () => {
    const broken = ci.replace(/ && \[ "\$TEST_SHARDS" != "success" \]/, '');
    expect(broken, 'mutation did not apply').not.toBe(ci);
    expect(assertsShardsSucceeded(jobBody(broken, 'ci-complete'), 'DEPLOYABLE', 'TEST_SHARDS')).toBe(false);
  });

  it('sees test-shards dropped from needs', () => {
    const broken = ci.replace(/^ {6}- test-shards\n/m, '');
    expect(broken, 'mutation did not apply').not.toBe(ci);
    expect(readNeeds(jobBody(broken, 'ci-complete'))).not.toContain('test-shards');
  });
});
