import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readJobCondition, readJobs, readNeeds, readSteps } from './ciWorkflowText';

/**
 * Guard on ci.yml's `leak-shapes` job, the CI half of the husky pre-commit leak-shapes guard.
 *
 * It must run on every change, docs-only ones included: `docs/**` and `docs-site/**` are
 * non-deployable, and they are exactly where planning artifacts and pasted identifiers land. Gating
 * it on `deployable` (as `repo-guards` is) would skip it there, and a skipped job counts as passing
 * in `ci-complete`, so the regression would be silent. Text-matched like the sibling
 * check*JobWired tests; the last describe proves the helpers see a broken copy.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

function jobBody(source: string, name: string): string {
  return readJobs(source).find(job => job.name === name)?.body ?? '';
}

function runsCheck(step: string): boolean {
  return /^\s*run:\s*bash scripts\/check-no-leak-shapes\.sh --changed "\$LEAK_SHAPES_BASE"\s*$/m.test(step);
}

/** The env var `ci-complete` maps `needs.leak-shapes.result` to, if it maps it at all. */
function readResultEnvVar(body: string): string | undefined {
  return /^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.leak-shapes\.result\s*\}\}\s*$/m.exec(body)?.[1];
}

function resultLoopIncludes(body: string, envVar: string): boolean {
  return new RegExp(`^\\s*for r in .*"\\$${envVar}"`, 'm').test(body);
}

describe('leak-shapes job in ci.yml', () => {
  const body = jobBody(ci, 'leak-shapes');

  it('exists and runs the guard in --changed mode', () => {
    expect(body, 'ci.yml has no leak-shapes job').not.toBe('');
    expect(readSteps(body).some(runsCheck)).toBe(true);
  });

  it('runs unconditionally, with no deployable gate', () => {
    expect(readJobCondition(body)).toBe('');
    expect(readNeeds(body)).not.toContain('changes');
  });

  it('does not continue on error', () => {
    expect(body).not.toMatch(/continue-on-error:/);
  });

  it('is aggregated into the required ci-complete check', () => {
    const ciComplete = jobBody(ci, 'ci-complete');
    expect(readNeeds(ciComplete)).toContain('leak-shapes');
    const envVar = readResultEnvVar(ciComplete);
    expect(envVar, 'ci-complete does not map needs.leak-shapes.result into its env').toBeDefined();
    expect(resultLoopIncludes(ciComplete, envVar!)).toBe(true);
  });

  it('is not also run from the deployable-gated repo-guards job', () => {
    expect(readSteps(jobBody(ci, 'repo-guards')).some(step => step.includes('check-no-leak-shapes.sh'))).toBe(false);
  });
});

describe('the wiring checks reject a broken workflow', () => {
  function mutate(source: string, pattern: RegExp, replacement: string): string {
    const mutated = source.replace(pattern, replacement);
    expect(mutated, `mutation ${pattern} did not apply`).not.toBe(source);
    return mutated;
  }

  it('sees a deployable gate added to the job', () => {
    const broken = mutate(
      ci,
      /(\n {2}leak-shapes:\n)/,
      "$1    needs: changes\n    if: needs.changes.outputs.deployable == 'true'\n"
    );
    expect(readJobCondition(jobBody(broken, 'leak-shapes'))).toBe("needs.changes.outputs.deployable == 'true'");
  });

  it('sees the job dropped from the ci-complete result loop', () => {
    const broken = mutate(ci, / "\$LEAK_SHAPES"/g, '');
    const ciComplete = jobBody(broken, 'ci-complete');
    expect(readResultEnvVar(ciComplete)).toBe('LEAK_SHAPES');
    expect(resultLoopIncludes(ciComplete, 'LEAK_SHAPES')).toBe(false);
  });
});
