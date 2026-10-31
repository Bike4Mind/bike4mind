import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readJobCondition, readJobs, readNeeds, readSteps } from './ciWorkflowText';

/**
 * Guard on ci.yml's `secret-scan` job, the blocking gitleaks scan of the commits a change adds.
 *
 * Every link below fails quiet rather than red, because `ci-complete` is the only required check
 * and a skipped job counts as passing:
 *
 * - it must run on EVERY change. Gating it on `changes` (directly, or by moving it back into
 *   `repo-guards`) skips it on a docs / `**\/*.md` / `**\/.env.example` change, which is where a
 *   pasted credential is most likely to land;
 * - the scan must exit non-zero on a finding and nothing may swallow that;
 * - it is aggregated through `ci-complete`'s `needs`, env mapping and result loop.
 *
 * Text-matched rather than YAML-parsed, following checkPublishedDtsJobWired.test.ts.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const ci = fs.readFileSync(CI_WORKFLOW, 'utf8');

function jobBody(source: string, name: string): string {
  return readJobs(source).find(job => job.name === name)?.body ?? '';
}

/** The env var `ci-complete` maps `needs.secret-scan.result` to, if it maps it at all. */
function readResultEnvVar(body: string): string | undefined {
  return /^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.secret-scan\.result\s*\}\}\s*$/m.exec(body)?.[1];
}

function resultLoopIncludes(body: string, envVar: string): boolean {
  return new RegExp(`^\\s*for r in .*"\\$${envVar}"`, 'm').test(body);
}

/** Steps that run a blocking gitleaks scan: both the range and the fallback branch must block. */
function blockingScanCount(step: string): number {
  return (step.match(/gitleaks detect [^\n]*--exit-code 1/g) ?? []).length;
}

describe('secret-scan job in ci.yml', () => {
  const body = jobBody(ci, 'secret-scan');

  it('exists', () => {
    expect(body, 'ci.yml has no secret-scan job').not.toBe('');
  });

  it('runs on every change: no condition and no dependency on the changes gate', () => {
    expect(readJobCondition(body)).toBe('');
    expect(readNeeds(body)).toEqual([]);
  });

  it('checks out full history so the commit range resolves', () => {
    expect(body).toMatch(/^\s+fetch-depth:\s*0\s*$/m);
  });

  it('self-tests the config, then scans with --exit-code 1 on both branches', () => {
    const steps = readSteps(body);
    expect(steps.some(step => /GITLEAKS_REQUIRED: '1'/.test(step) && /gitleaks-config-selftest\.sh/.test(step))).toBe(
      true
    );
    const scan = steps.find(step => /--log-opts=/.test(step));
    expect(scan, 'secret-scan has no range scan step').toBeDefined();
    expect(blockingScanCount(scan!)).toBe(2);
  });

  it('does not continue on error', () => {
    expect(body).not.toMatch(/continue-on-error:/);
  });

  it('is not duplicated inside repo-guards, which skips non-deployable changes', () => {
    expect(jobBody(ci, 'repo-guards')).not.toMatch(/gitleaks detect/);
  });

  it('is aggregated into the required ci-complete check', () => {
    const ciComplete = jobBody(ci, 'ci-complete');
    expect(readNeeds(ciComplete)).toContain('secret-scan');
    const envVar = readResultEnvVar(ciComplete);
    expect(envVar, 'ci-complete does not map needs.secret-scan.result into its env').toBeDefined();
    expect(resultLoopIncludes(ciComplete, envVar!)).toBe(true);
  });
});

describe('the secret-scan checks reject a broken workflow', () => {
  function mutate(source: string, pattern: RegExp, replacement: string): string {
    const mutated = source.replace(pattern, replacement);
    expect(mutated, `mutation ${pattern} did not apply`).not.toBe(source);
    return mutated;
  }

  it('sees secret-scan gated on the deployable signal', () => {
    const broken = mutate(
      ci,
      /(\n {2}secret-scan:\n)/,
      "$1    needs: changes\n    if: needs.changes.outputs.deployable == 'true'\n"
    );
    const body = jobBody(broken, 'secret-scan');
    expect(readNeeds(body)).toEqual(['changes']);
    expect(readJobCondition(body)).not.toBe('');
  });

  it('sees secret-scan dropped from the ci-complete result loop', () => {
    const broken = mutate(ci, / "\$SECRET_SCAN"/g, '');
    const ciComplete = jobBody(broken, 'ci-complete');
    expect(readResultEnvVar(ciComplete)).toBe('SECRET_SCAN');
    expect(resultLoopIncludes(ciComplete, 'SECRET_SCAN')).toBe(false);
  });

  it('sees a scan that no longer blocks', () => {
    const broken = mutate(ci, /(gitleaks detect [^\n]*)--exit-code 1/, '$1--exit-code 0');
    const scan = readSteps(jobBody(broken, 'secret-scan')).find(step => /--log-opts=/.test(step))!;
    expect(blockingScanCount(scan)).toBe(1);
  });
});
