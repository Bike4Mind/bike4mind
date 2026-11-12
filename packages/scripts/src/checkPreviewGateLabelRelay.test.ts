import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard: label changes reach the preview gate only through the relay, and the relay only
 * reacts to the two labels the gate reads.
 *
 * The gate used to listen on `labeled` / `unlabeled` directly. Every label change on a PR
 * then started a required-check run, and review-state swaps alone were two thirds of its
 * runs. The gate cannot filter those with a job-level `if`, because a skipped required check
 * counts as passing. The relay can: it is not a required check, so a skipped relay job is
 * free and reports nothing. On a match it re-runs the head's latest gate run, which attaches
 * to the same check run and reads labels live.
 *
 * Two shapes are pinned because each has a silent failure mode:
 * - The relay job name must not equal the gate's. A second check run called `preview gate`
 *   would satisfy the required check on its own.
 * - A re-run replays the original event payload, so the gate's waiver-expiry step must run
 *   on the first attempt only, or a relay re-run after a maintainer sets `skip-preview`
 *   would remove the waiver it was asked to honour.
 *
 * Text-matched rather than YAML-parsed, matching the sibling guards.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const gate = fs.readFileSync(path.join(WORKFLOWS, 'sst-infra-preview-gate.yml'), 'utf8');
const relay = fs.readFileSync(path.join(WORKFLOWS, 'sst-infra-preview-gate-relay.yml'), 'utf8');

/** Every `types:` line under the top-level `on:` block. */
function triggerTypes(src: string): string[] {
  return src.match(/^ {4}types: \[.*\]$/gm) ?? [];
}

describe('preview gate label relay', () => {
  it('keeps label events off the gate itself', () => {
    const types = triggerTypes(gate);
    expect(types.length).toBeGreaterThan(0);
    for (const line of types) {
      expect(line).not.toContain('labeled');
      expect(line).toContain('synchronize');
    }
  });

  it('listens to label events on the trusted trigger and on a path-scoped self-check', () => {
    expect(relay).toMatch(/^ {2}pull_request_target:\n {4}types: \[labeled, unlabeled\]$/m);
    expect(relay).toMatch(
      /^ {2}pull_request:\n {4}types: \[labeled, unlabeled\]\n {4}paths: \['\.github\/workflows\/sst-infra-preview-gate-relay\.yml'\]/m
    );
  });

  it('reacts only to the two labels the gate reads', () => {
    const condition = relay.match(/^ {4}if: >\n((?: {6}.*\n)+)/m)?.[1] ?? '';
    expect(condition).toContain("github.event.label.name == 'preview-deployed'");
    expect(condition).toContain("github.event.label.name == 'skip-preview'");
    // Any other label name in the condition means the relay fires on something the gate ignores.
    const names = condition.match(/github\.event\.label\.name == '([^']+)'/g) ?? [];
    expect(names).toHaveLength(2);
  });

  it('re-runs the gate rather than starting a new run, with no checkout and only the actions scope', () => {
    expect(relay).toContain('actions/workflows/sst-infra-preview-gate.yml/runs?event=pull_request_target&head_sha=');
    expect(relay).toMatch(/actions\/runs\/\$run_id\/rerun/);
    expect(relay).not.toContain('actions/checkout');
    expect(relay).toMatch(/^permissions:\n {2}actions: write\n\n/m);
  });

  it('never publishes a check run named like the gate', () => {
    expect(gate).toMatch(/^ {4}name: preview gate$/m);
    expect(relay).not.toMatch(/^ {4}name: preview gate$/m);
    expect(relay).toMatch(/^ {4}name: preview gate relay$/m);
  });

  it('expires the waiver on the first attempt only, so a relay re-run cannot undo a fresh waiver', () => {
    expect(gate).toMatch(
      /^ {6}- name: Expire preview waiver on push\n(?: {8}#.*\n)* {8}if: github\.run_attempt == 1$/m
    );
  });
});
