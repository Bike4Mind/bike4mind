import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on ci.yml's `help-docs` job and the artifact fallback that makes it work.
 *
 * `help-docs` is the only leg that runs the help suites on a docs-only PR, and every part of
 * how it reaches them is load-bearing and invisible from the test files themselves:
 *
 * - it is gated on `docs-changed`, not `deployable`, because a docs-only change is
 *   non-deployable and a skipped required check counts as passing;
 * - its suites import @bike4mind/common, whose package entries point at dist/, so it needs the
 *   core packages built - but `core-build` is itself gated on `deployable` and therefore skips
 *   on exactly the runs this job exists for. A status-check function in the `if` is what lifts
 *   the implicit `success()` on `needs` and lets that skip through;
 * - with `core-build` skipped the artifact name interpolates to the literal `core-build-`, so
 *   the download fails by design and the local `pnpm core:build` fallback is the real build.
 *
 * Remove any one of those and the job does not go red - it goes quiet, or never starts, and a
 * docs PR ships green with the guards unrun. That is the same shape as the gap this job was
 * added to close, so the wiring is pinned here rather than left to review.
 *
 * `always()` is called out separately because it is the tempting spelling and the wrong one: it
 * is the one status-check function that stays true through run cancellation, and PR runs are
 * cancel-in-progress. A superseded push would cancel the run and still leave this job holding a
 * runner for an install plus a full core build. Sibling jobs that use `always()` (the `test`
 * aggregator, `ci-complete`) only echo and assert, so the scope here is jobs that pair it with
 * the expensive core-build download.
 *
 * Text-matched rather than YAML-parsed, following checkClientTestShards.test.ts's precedent: the
 * repo carries no YAML parser dependency and the assertions wanted are over literal expressions.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const CHANGES_FILTER = path.join(REPO_ROOT, '.github', 'actions', 'changes-filter', 'action.yml');

/** The artifact name every consumer of the core build downloads by. */
const CORE_ARTIFACT = 'core-build-${{ needs.core-build.outputs.core-content-hash }}';

type Job = { name: string; body: string };

/**
 * Jobs under the workflow's `jobs:` key, as name -> the job mapping's source text.
 *
 * Comment lines are dropped first: ci.yml's job docblocks quote `needs:`, `if:` and the artifact
 * name while explaining them, and prose that reads like a declaration must not count as one (the
 * sibling shard guard's first red run was exactly that mistake, in reverse).
 */
function readJobs(contents: string): Job[] {
  const lines = contents.split('\n').filter(line => !/^\s*#/.test(line));
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (start === -1) return [];

  const jobs: Job[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      jobs.push({ name: header[1], body: '' });
    } else if (jobs.length > 0) {
      jobs[jobs.length - 1].body += `${line}\n`;
    }
  }
  return jobs;
}

/**
 * A job's `if:` value as one line, folding the block-scalar form (`if: |`) back together.
 *
 * The block form is not cosmetic here: `!` opens a YAML tag, so the inline `if: !cancelled() &&
 * ...` that a reader might collapse this to is a parse error rather than a condition.
 */
function readJobCondition(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex(line => /^ {4}if:/.test(line));
  if (start === -1) return '';

  const inline = lines[start].replace(/^ {4}if:\s*/, '').trim();
  if (!/^[|>][-+]?$/.test(inline)) return inline;

  const folded: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^ {6}/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}

/** A job's steps, each as source text, split on the `- ` list markers under `steps:`. */
function readSteps(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex(line => /^ {4}steps:\s*$/.test(line));
  if (start === -1) return [];

  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^ {6}/.test(line)) break;
    if (/^ {6}- /.test(line)) {
      steps.push(`${line}\n`);
    } else if (steps.length > 0) {
      steps[steps.length - 1] += `${line}\n`;
    }
  }
  return steps;
}

/**
 * Whether a job `if` lifts the implicit `success()` that GitHub otherwise applies to `needs`.
 *
 * Only these three do it while still admitting a non-success dependency; `success()` lifts it and
 * then re-imposes it. Without one of them a job that `needs: core-build` can never run on a
 * docs-only PR, because core-build is skipped there.
 */
function liftsNeedsSuccessGate(condition: string): boolean {
  return /\b(always|cancelled|failure)\s*\(\s*\)/.test(condition);
}

/** The step that downloads the core-build artifact, if the job has one. */
function coreDownloadStep(steps: string[]): string | undefined {
  return steps.find(step => /uses:\s*actions\/download-artifact/.test(step) && step.includes(CORE_ARTIFACT));
}

/**
 * A step's `id:`, which is how a later step refers to its outcome. The optional `- ` allows for
 * `id:` being the key the step's list marker sits on, which is as valid as putting `name:` first.
 */
function readStepId(step: string): string | undefined {
  return /^\s*(?:-\s+)?id:\s*(\S+)\s*$/m.exec(step)?.[1];
}

const ci = fs.readFileSync(CI_WORKFLOW, 'utf8');
const jobs = readJobs(ci);

describe('ci.yml job parsing', () => {
  // Anti-vacuity: every assertion below is an `expect` on something this parser found, so a
  // parser that silently returns nothing turns the whole file green.
  it('finds the jobs ci.yml declares', () => {
    const names = jobs.map(job => job.name);
    expect(names).toContain('changes');
    expect(names).toContain('core-build');
    expect(names).toContain('help-docs');
    expect(names).toContain('ci-complete');
  });
});

describe('help-docs job in ci.yml', () => {
  const helpDocs = jobs.find(job => job.name === 'help-docs');
  const condition = readJobCondition(helpDocs?.body ?? '');
  const steps = readSteps(helpDocs?.body ?? '');

  it('exists and still runs the help suites', () => {
    expect(helpDocs, 'no help-docs job in ci.yml; nothing runs the help guards on a docs-only PR').toBeDefined();
    expect(steps.join('')).toContain('help/__tests__');
  });

  it('needs both the changes gate and core-build', () => {
    const needs = /^ {4}needs:\s*(.+)$/m.exec(helpDocs?.body ?? '')?.[1] ?? '';
    expect(needs).toContain('changes');
    expect(needs).toContain('core-build');
  });

  // A leg whose failure nobody aggregates is a leg that can fail green: `ci-complete` is the
  // only required check, so dropping help-docs from its `needs` silently un-gates the guards.
  it('is aggregated into the required ci-complete check', () => {
    const ciComplete = jobs.find(job => job.name === 'ci-complete');
    expect(/^ {4}needs:\s*(.+)$/m.exec(ciComplete?.body ?? '')?.[1] ?? '').toContain('help-docs');
    expect(ciComplete?.body).toContain('needs.help-docs.result');
  });

  it('gates on docs-changed, not on deployable', () => {
    expect(condition).toContain("needs.changes.outputs.docs-changed == 'true'");
    // `deployable` is false on a docs-only PR, which is the run this job exists for.
    expect(condition).not.toContain('needs.changes.outputs.deployable');
  });

  it('still runs when core-build was skipped', () => {
    expect(
      liftsNeedsSuccessGate(condition),
      'without a status-check function the implicit success() on needs makes a skipped core-build skip this job too'
    ).toBe(true);
    // An allowlist of success/skipped drops the `cancelled` case (runner loss), and ci-complete
    // only reddens on the literal `failure`, so the job would go missing on a green docs PR.
    expect(condition).toContain("needs.core-build.result != 'failure'");
  });
});

describe('jobs that tolerate a skipped core-build', () => {
  const tolerant = jobs.filter(
    job => liftsNeedsSuccessGate(readJobCondition(job.body)) && coreDownloadStep(readSteps(job.body)) !== undefined
  );

  it('are found at all', () => {
    expect(tolerant.map(job => job.name)).toContain('help-docs');
  });

  it.each(tolerant.map(job => job.name))('%s does not use always(), which survives cancellation', name => {
    const condition = readJobCondition(jobs.find(job => job.name === name)!.body);
    expect(
      condition,
      `${name} pairs always() with a core build; a cancelled run would still pay for the runner`
    ).not.toMatch(/\balways\s*\(\s*\)/);
  });

  // The artifact name interpolates to the literal `core-build-` when core-build was skipped, so
  // the download is EXPECTED to fail on the runs these jobs exist for. Without
  // continue-on-error the step failure ends the job before any fallback can run, and without the
  // fallback the job runs its suites against a core that was never built.
  it.each(tolerant.map(job => job.name))('%s falls back to a local core build', name => {
    const steps = readSteps(jobs.find(job => job.name === name)!.body);
    const download = coreDownloadStep(steps)!;

    expect(download, `${name}'s core-build download should be non-fatal`).toMatch(/^\s*continue-on-error:\s*true\s*$/m);

    const id = readStepId(download);
    expect(id, `${name}'s core-build download needs an id for a later step to read its outcome`).toBeDefined();

    const fallback = steps.find(step => step.includes(`steps.${id}.outcome == 'failure'`));
    expect(fallback, `${name} has no step gated on steps.${id}.outcome == 'failure'`).toBeDefined();
    // `conclusion` is `success` whenever continue-on-error swallowed the failure, so a fallback
    // written against it never fires.
    expect(fallback).not.toContain(`steps.${id}.conclusion`);
    expect(fallback).toContain('core:build');
  });
});

describe('changes-filter docs-paths', () => {
  const action = fs.readFileSync(CHANGES_FILTER, 'utf8');
  const defaultBlock =
    /^ {4}default: \|\n((?: {6}.*\n)+)/m.exec(action.slice(action.indexOf('docs-paths:')))?.[1] ?? '';

  // The trigger half of the same wiring: help-docs is the only job that runs
  // packages/scripts/help/**, so dropping it from the pathspec list lets a change to those
  // scripts skip the guard that covers it - which is how the resolve error this job now
  // fixes first reached main.
  it('covers the help tooling as well as the docs corpus', () => {
    expect(defaultBlock).toContain('docs-site/**');
    expect(defaultBlock).toContain('packages/scripts/help/**');
  });
});

describe('readJobs', () => {
  const sample = [
    'jobs:',
    '  alpha:',
    '    runs-on: ubuntu-latest',
    '  beta:',
    '    needs: alpha',
    '',
    'concurrency:',
    '  group: x',
  ].join('\n');

  it('splits on the two-space job keys and stops at column 0', () => {
    expect(readJobs(sample).map(job => job.name)).toEqual(['alpha', 'beta']);
    expect(readJobs(sample)[1].body).toContain('needs: alpha');
  });

  it('does not read a commented-out job header as a job', () => {
    expect(readJobs(['jobs:', '  # gamma:', '  alpha:', '    runs-on: x'].join('\n')).map(j => j.name)).toEqual([
      'alpha',
    ]);
  });

  it('finds nothing when there is no jobs block', () => {
    expect(readJobs('on:\n  push:\n')).toEqual([]);
  });
});

describe('readJobCondition', () => {
  it('reads the inline form', () => {
    expect(readJobCondition("    if: needs.changes.outputs.deployable == 'true'\n")).toBe(
      "needs.changes.outputs.deployable == 'true'"
    );
  });

  it('folds the block-scalar form onto one line', () => {
    const body = [
      '    if: |',
      '      !cancelled() &&',
      "      needs.core-build.result != 'failure'",
      '    runs-on: x',
    ].join('\n');
    expect(readJobCondition(body)).toBe("!cancelled() && needs.core-build.result != 'failure'");
  });

  it('returns empty for a job with no condition', () => {
    expect(readJobCondition('    runs-on: ubuntu-latest\n')).toBe('');
  });
});

describe('liftsNeedsSuccessGate', () => {
  it('accepts the three functions that admit a non-success dependency', () => {
    expect(liftsNeedsSuccessGate('always() && x')).toBe(true);
    expect(liftsNeedsSuccessGate('!cancelled() && x')).toBe(true);
    expect(liftsNeedsSuccessGate('failure() || x')).toBe(true);
  });

  it('rejects a plain condition, which leaves the implicit success() in place', () => {
    expect(liftsNeedsSuccessGate("needs.changes.outputs.docs-changed == 'true'")).toBe(false);
    expect(liftsNeedsSuccessGate('')).toBe(false);
  });
});

describe('readSteps', () => {
  const body = [
    '    steps:',
    '      - name: one',
    '        run: echo 1',
    '      - name: two',
    '        id: two',
    '        run: echo 2',
  ].join('\n');

  it('splits a job body into its steps', () => {
    const steps = readSteps(body);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('echo 1');
    expect(readStepId(steps[1])).toBe('two');
    expect(readStepId(steps[0])).toBeUndefined();
  });

  it('reads an id that the step list marker sits on', () => {
    expect(readStepId('      - id: download-core\n        uses: actions/download-artifact@v7\n')).toBe('download-core');
  });

  it('finds nothing for a job with no steps key', () => {
    expect(readSteps('    uses: ./.github/workflows/other.yml\n')).toEqual([]);
  });
});
