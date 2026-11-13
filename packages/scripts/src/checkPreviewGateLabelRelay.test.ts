import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
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

const relayScript = relay.split('        run: |\n')[1];
if (!relayScript) throw new Error('Preview gate relay shell is missing');

type RerunCase = 'expired' | 'forbidden' | 'busy' | 'success' | 'missing';
function runRelay(scenario: RerunCase) {
  const script = `set -euo pipefail
export REPO=example/repo HEAD_SHA=example-head LABEL=skip-preview ACTION=labeled
scenario=${scenario}
posts=0
gh() {
  if [ "$1" != "api" ]; then return 99; fi
  if [ "\${2:-}" != "-X" ]; then
    if [ "$scenario" != "missing" ]; then printf '123\\n'; fi
    return 0
  fi
  posts=$((posts + 1))
  printf 'POST %s\\n' "$posts" >&2
  case "$scenario" in
    expired) printf 'gh: This workflow was created over a month ago (HTTP 403)\\n' >&2; return 1 ;;
    forbidden) printf 'gh: Resource not accessible by integration (HTTP 403)\\n' >&2; return 1 ;;
    busy)
      if [ "$posts" -eq 1 ]; then printf 'gh: already running (HTTP 409)\\n' >&2; return 1; fi
      ;;
  esac
  return 0
}
sleep() { printf 'SLEEP %s\\n' "$1"; }
${relayScript}`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('preview gate relay actual shell failures', () => {
  it('explains an expired run, fails honestly and makes only one POST without sleeping', () => {
    const result = runRelay('expired');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::warning title=Gate run expired::');
    expect(result.stdout).toContain('Push a new commit');
    expect(result.stdout).toContain('existing gate result has not changed');
    expect(result.stdout.match(/POST /g)).toHaveLength(1);
    expect(result.stdout).not.toContain('SLEEP');
    expect(result.stdout).not.toContain('Re-run requested.');
  });

  it('does not mistake an unrelated 403 for an expired run', () => {
    const result = runRelay('forbidden');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Resource not accessible');
    expect(result.stdout).not.toContain('Gate run expired');
    expect(result.stdout).not.toContain('SLEEP');
  });

  it('still retries a busy run and succeeds when GitHub accepts the next request', () => {
    const result = runRelay('busy');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SLEEP 15');
    expect(result.stdout).toContain('Re-run requested.');
  });

  it('returns success immediately for a successful request', () => {
    const result = runRelay('success');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Re-run requested.');
    expect(result.stdout).not.toContain('SLEEP');
  });

  it('keeps the existing no-run warning without attempting a POST', () => {
    const result = runRelay('missing');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning title=No gate run::');
    expect(result.stdout).not.toContain('POST');
    expect(result.stdout).not.toContain('Re-run requested.');
  });
});
