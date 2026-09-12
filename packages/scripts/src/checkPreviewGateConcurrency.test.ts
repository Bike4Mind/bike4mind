import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard: the SST / infra preview gate collapses duplicate runs per PR, and only per PR.
 *
 * The gate listens on `labeled` and `unlabeled` because those are what re-evaluate it the
 * moment a preview lands or is torn down. A label swap - one label removed and another added
 * in the same instant - emits both events together, so GitHub starts two identical runs on
 * the same SHA. Nothing errors and both runs reach the same verdict, so the only visible
 * symptom is the runner bill and a doubled entry in the checks list. Any bot that moves a PR
 * between mutually exclusive states (review, QA) produces the swap.
 *
 * The fix has a worse failure mode than the bug. A concurrency key that is not per-PR makes
 * every PR cancel every other PR's gate run, and a cancelled check is not a passing one, so a
 * required gate would flap red across the whole fleet while reading, in the workflow file,
 * like ordinary hygiene. Hence the second assertion here, which is the one worth having.
 *
 * There is also a tempting fix that does not work, recorded so nobody reaches for it: filtering
 * `labeled` / `unlabeled` by label name in a job-level `if`. A job skipped by an `if` still
 * publishes a check run whose conclusion is `skipped`, and branch protection counts skipped as
 * passing - so the gate would report green on a PR it had never evaluated.
 *
 * Text-matched rather than YAML-parsed, matching the sibling guards: the repo carries no YAML
 * parser dependency and adding one for a workflow assertion is not worth the supply chain.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE = path.join(REPO_ROOT, '.github', 'workflows', 'sst-infra-preview-gate.yml');

/** The top-level `concurrency:` mapping, as source text. Column-0 anchored so a nested one cannot match. */
function concurrencyBlock(src: string): string {
  return src.match(/^concurrency:\n(?: {2}.*\n)+/m)?.[0] ?? '';
}

describe('preview gate duplicate-run collapse', () => {
  const src = fs.readFileSync(GATE, 'utf8');
  const block = concurrencyBlock(src);

  it('declares a top-level concurrency group that cancels the superseded run', () => {
    expect(block).not.toBe('');
    expect(block).toMatch(/^ {2}cancel-in-progress: true$/m);
  });

  it('keys the group on the PR, so one PR can never cancel another', () => {
    const group = block.match(/^ {2}group: (.+)$/m)?.[1] ?? '';
    expect(group).toContain('github.event.pull_request.number');
    // merge_group carries no PR number. Without the fallback the key collapses to a
    // constant and every queue entry cancels the one before it.
    expect(group).toContain('github.ref');
  });

  // Anti-vacuity: the assertions above are only meaningful if they are reading the real gate
  // and would actually notice its removal.
  it('is reading the real gate workflow', () => {
    expect(src).toContain('name: SST / infra preview gate');
    expect(src).toMatch(/^ {4}types: \[.*labeled.*\]$/m);
    expect(concurrencyBlock(src.replace(/^concurrency:\n(?: {2}.*\n)+/m, ''))).toBe('');
  });
});
