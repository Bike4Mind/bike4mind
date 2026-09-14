import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on how the e2e workflows react to an unset `E2E_CLEANUP_SECRET` (#1913).
 *
 * Preview stacks live in a separate AWS account the dev role cannot `sst shell` into, so a
 * preview-targeted run reads the secret from a repo secret instead. When that secret is not
 * configured the suite cannot start at all - and the interesting question is what the run then
 * REPORTS. Hard-failing renders a normal red run that executed zero tests, which a reviewer
 * reasonably reads as "e2e broke on this PR". That misreading is the whole bug: for a month
 * every preview-targeted run was red for a configuration gap, and nothing anywhere said so.
 *
 * So the invariant is that a missing secret is a third state. Each guard must exit 0 after
 * announcing itself and raising a `preview_skipped` flag, and the surfaces that render a verdict
 * from that flag (the Slack status, the PR comment) branch on it AHEAD of pass/fail. Exiting 0
 * without the announcement would be strictly worse than the original bug - a green run, zero
 * tests - so the shape is pinned here rather than left to review.
 *
 * The promotion commit status is not flag-driven and so is asserted separately below: it already
 * returns early when no results were parsed, which a skip satisfies for free.
 *
 * Nothing else can catch a regression: re-hardening a guard to `exit 1` breaks no build, and
 * the run it misreports only happens on a preview dispatch that no gate exercises.
 *
 * Text-matched rather than YAML-parsed on purpose, matching the sibling guard in
 * `checkClientTestShards.test.ts` - the repo has no YAML parser dependency, and the assertion
 * wanted is precisely about the literal shell the workflow runs.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Every workflow that guards on the secret today. Asserted to be exactly the set discovered by
 * scanning, so this list cannot silently drift: a new preview-capable workflow fails here until
 * it is added, and a deleted guard fails rather than leaving the shape assertions below to pass
 * over an empty set.
 */
const EXPECTED_GUARD_FILES = ['e2e-ai-latency.yml', 'e2e-on-label.yml', 'e2e-run.yml'];

type Guard = { file: string; body: string };

/**
 * The body of each `if [ -z "${E2E_CLEANUP_SECRET:-}" ]; then ... fi` block.
 *
 * The closing `fi` is anchored to the opening `if`'s own indentation (backreference) so a block
 * cannot run past its end and swallow later branches - these guards sit inside `case` arms whose
 * surrounding shell contains plenty of other `fi`s.
 */
function readSecretGuards(file: string, contents: string): Guard[] {
  const pattern = /^([ \t]*)if \[ -z "\$\{E2E_CLEANUP_SECRET:-\}" \]; then\r?\n([\s\S]*?)\r?\n\1fi$/gm;
  return [...contents.matchAll(pattern)].map(match => ({ file, body: match[2] }));
}

function readWorkflows(): Array<{ file: string; contents: string }> {
  return fs
    .readdirSync(WORKFLOW_DIR)
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort()
    .map(file => ({ file, contents: fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8') }));
}

const workflows = readWorkflows();
const guards = workflows.flatMap(({ file, contents }) => readSecretGuards(file, contents));

describe('e2e preview E2E_CLEANUP_SECRET guard', () => {
  it('finds the guard in exactly the workflows that are supposed to have one', () => {
    const filesWithGuards = [...new Set(guards.map(guard => guard.file))].sort();
    expect(filesWithGuards).toEqual(EXPECTED_GUARD_FILES);
  });

  // Two guards live in e2e-ai-latency.yml (model discovery and the benchmark matrix), so the
  // count exceeds the file count. Pinned so that deleting one guard fails here even though the
  // file still contains the other - the per-file assertion above cannot see that.
  it('finds every guard occurrence, including the two in e2e-ai-latency.yml', () => {
    expect(guards).toHaveLength(4);
  });

  it.each(EXPECTED_GUARD_FILES)('reports a missing secret as a labeled skip in %s', file => {
    const fileGuards = guards.filter(guard => guard.file === file);
    expect(fileGuards.length).toBeGreaterThan(0);

    for (const guard of fileGuards) {
      // Exiting 0 is what stops a configuration gap from rendering as a test failure...
      expect(guard.body).toMatch(/^\s*exit 0$/m);
      expect(guard.body).not.toMatch(/^\s*exit 1$/m);
      // ...and the annotation is what stops it from rendering as nothing at all.
      expect(guard.body).toMatch(/echo "::warning::preview e2e unavailable: E2E_CLEANUP_SECRET/);
      // The flag is what the verdict surfaces read. Asserted at the emitting end too, because
      // the rendering assertions below only prove a surface CONSULTS it - deleting just this
      // line would leave them green while every skip silently rendered as a pass.
      expect(guard.body).toMatch(/echo "preview_skipped=true" >> "\$GITHUB_OUTPUT"/);
    }
  });
});

describe('e2e skip rendering', () => {
  const read = (file: string) => fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');

  /**
   * A skip exits 0, so any surface that derives its verdict from the step's outcome alone would
   * render it as a pass - a green "E2E Tests Passed" on a PR where nothing ran, which is the
   * more dangerous half of the original bug inverted. Each surface below must consult the skip
   * flag. Asserted per-surface rather than as one grep of the file so that adding a second
   * verdict surface without a skip branch is not covered by the first one's match.
   */
  it('branches the Slack status on the skip before pass/fail', () => {
    const contents = read('e2e-run.yml');
    const statusExpressions = [...contents.matchAll(/"text": "\*Status\*[^"]*"/g)].map(m => m[0]);
    expect(statusExpressions).toHaveLength(1);

    for (const expression of [
      ...statusExpressions,
      ...[...contents.matchAll(/"text": "Playwright E2E[^\n]*Passed[^\n]*/g)].map(m => m[0]),
    ]) {
      const skipAt = expression.indexOf("steps.e2e.outputs.preview_skipped == 'true'");
      const passAt = expression.indexOf(':white_check_mark: Passed');
      expect(skipAt).toBeGreaterThanOrEqual(0);
      // GitHub expressions short-circuit left to right, so a skip branch placed after the pass
      // branch would never be reached.
      expect(passAt).toBeGreaterThan(skipAt);
    }
  });

  // A skip parses zero results, so the zero-total early return is what keeps the promotion
  // status missing instead of posting a red one. Preview runs are never promotable anyway
  // (both callers tie `stamp_promotable` to an empty `pr_number`), so this is the backstop
  // rather than the primary defence - but it is the only one that would survive a caller
  // deciding to stamp a preview.
  it('leaves the promotion commit status unset when no results were parsed', () => {
    const contents = read('e2e-run.yml');
    expect(contents).toMatch(
      /const total = Number\(process\.env\.TOTAL \|\| '0'\);\n\s*(\/\/[^\n]*\n\s*)*if \(total === 0\) \{/
    );
  });

  it('renders the PR comment as Skipped rather than Passed', () => {
    const contents = read('e2e-on-label.yml');
    expect(contents).toMatch(/const skipped = '\$\{\{ steps\.e2e\.outputs\.preview_skipped \}\}' === 'true'/);
    expect(contents).toMatch(/skipped \? 'Skipped' :/);
  });
});
