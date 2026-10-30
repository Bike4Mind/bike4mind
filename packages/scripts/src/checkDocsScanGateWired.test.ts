import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readJobCondition, readJobs, readNeeds } from './ciWorkflowText';

/**
 * Guard on ci.yml's `docs-scan-gate` job, the only thing that turns the private pre-merge
 * `docs/sensitive-scan` status into a merge block. `ci-complete` is the only required check and it
 * only reddens on a literal `failure`, so dropping the job from its `needs`, env mapping or result
 * loop lets a flagged docs PR merge (and auto-deploy) with nothing turning red.
 *
 * Text-matched like checkPublishedDtsJobWired.test.ts; the last describe runs the helpers over a
 * broken copy so a parser that stops seeing the wiring fails instead of passing vacuously.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const jobBody = (source: string, name: string) => readJobs(source).find(job => job.name === name)?.body ?? '';

function readResultEnvVar(body: string): string | undefined {
  return /^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.docs-scan-gate\.result\s*\}\}\s*$/m.exec(body)?.[1];
}

function resultLoopIncludes(body: string, envVar: string): boolean {
  return new RegExp(`^\\s*for r in .*"\\$${envVar}"`, 'm').test(body);
}

describe('docs-scan-gate job in ci.yml', () => {
  const body = jobBody(ci, 'docs-scan-gate');

  it('exists', () => {
    expect(body, 'ci.yml has no docs-scan-gate job').not.toBe('');
  });

  it('gates on docs-changed for pull requests only', () => {
    expect(readNeeds(body)).toContain('changes');
    expect(readJobCondition(body)).toBe(
      "needs.changes.outputs.docs-changed == 'true' && github.event_name == 'pull_request'"
    );
  });

  it('polls the docs/sensitive-scan status', () => {
    expect(body).toContain('"docs/sensitive-scan"');
  });

  // The timeout path must fail closed: once the poll loop ends without a result, the step exits non-zero.
  it('fails closed after the poll loop', () => {
    const afterLoop = body.slice(body.lastIndexOf('\n          done\n'));
    expect(afterLoop, 'no poll loop found').not.toBe(body);
    expect(afterLoop).toMatch(/^\s+exit 1\s*$/m);
  });

  it('does not continue on error', () => {
    expect(body).not.toMatch(/continue-on-error:/);
  });

  it('is aggregated into the required ci-complete check', () => {
    const ciComplete = jobBody(ci, 'ci-complete');
    expect(readNeeds(ciComplete)).toContain('docs-scan-gate');

    const envVar = readResultEnvVar(ciComplete);
    expect(envVar, 'ci-complete does not map needs.docs-scan-gate.result into its env').toBeDefined();
    expect(
      resultLoopIncludes(ciComplete, envVar!),
      `ci-complete's result loop does not include $${envVar}; a failed scan would not redden it`
    ).toBe(true);
  });
});

describe('the docs-scan-gate wiring check rejects a broken workflow', () => {
  it('sees docs-scan-gate dropped from the ci-complete result loop', () => {
    const broken = ci.replace(/ "\$DOCS_SCAN"/g, '');
    expect(broken, 'mutation did not apply').not.toBe(ci);
    const ciComplete = jobBody(broken, 'ci-complete');
    expect(readResultEnvVar(ciComplete)).toBe('DOCS_SCAN');
    expect(resultLoopIncludes(ciComplete, 'DOCS_SCAN')).toBe(false);
  });
});
