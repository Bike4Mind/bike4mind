import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Guard: the ai-latency run actually goes red when a latency budget is breached.
 *
 * This gate cannot fail in CI on the PR that breaks it. `e2e-ai-latency.yml` runs on
 * `schedule`/`workflow_dispatch` only, so it never executes as a PR check - delete the `exit 1`,
 * break the `if:`, or narrow the jq selector, and every PR stays green while the nightly silently
 * reverts to printing ":x: Failed" and exiting 0, which is the behaviour the gate was added to
 * replace. These assertions are the only pre-merge evidence it still holds.
 *
 * The jq selector is EXTRACTED FROM THE COMMITTED YAML AND RUN over fixtures rather than
 * pattern-matched: a selector can keep every literal this file could name and still match nothing
 * (drop `?`, invert a comparison, misspell a field), and text matching would pass for all of them.
 * The declarative parts - the step's `if:` and its `exit 1` - are text-matched, matching the
 * sibling guards: the repo carries no YAML parser dependency and adding one for a workflow
 * assertion is not worth the supply chain.
 */

// Checked up front, as checkBotFoldWritePath.test.ts does: without jq the lifted selector would
// fail inside execFileSync and read as a defect in the gate rather than a missing prerequisite.
if (spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).status !== 0) {
  throw new Error('checkAiLatencyGate: required host tool not on PATH: jq');
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'e2e-ai-latency.yml');
const yaml = fs.readFileSync(WORKFLOW, 'utf8');
const GATE_STEP = '- name: Fail the run on a latency breach';

/** The ABANDONED assignment, lifted verbatim so the test runs the shipped selector. */
function liftAbandonedSelector(): string {
  const line = yaml.split('\n').find(l => l.includes('ABANDONED="$(jq'));
  if (!line) throw new Error('ABANDONED assignment not found in e2e-ai-latency.yml');
  const match = line.match(/jq -r '([^']+)'/);
  if (!match) throw new Error(`could not lift a jq program from: ${line.trim()}`);
  return match[1];
}

function runSelector(artifact: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-latency-gate-'));
  try {
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, JSON.stringify(artifact));
    return execFileSync('jq', ['-r', liftAbandonedSelector(), file], { encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('abandoned-prompt selector (executed, not matched)', () => {
  it('counts an abandoned text prompt', () => {
    expect(
      runSelector({
        results: [
          { id: 'reuters', responseTimeSec: 16.204 },
          { id: 'smartphone', responseTimeSec: 300, incomplete: true },
        ],
      })
    ).toBe('1');
  });

  it('ignores an abandoned image/artifact prompt', () => {
    // Deliverable prompts are out of the gated average, so they must not trip the gate either.
    expect(
      runSelector({ results: [{ id: 'storybook', responseTimeSec: 466, incomplete: true, measuresDeliverable: true }] })
    ).toBe('0');
  });

  it('reads an artifact written before this field existed', () => {
    // Backward compatibility: a pre-change artifact has no `incomplete` key anywhere. The selector
    // must answer 0, not error - an error here would abort the aggregate mid-table.
    expect(runSelector({ results: [{ id: 'reuters', responseTimeSec: 16.204 }] })).toBe('0');
  });

  it('survives a results key that is missing entirely', () => {
    expect(runSelector({})).toBe('0');
  });

  it('counts each abandoned prompt separately', () => {
    expect(
      runSelector({
        results: [{ id: 'a', incomplete: true }, { id: 'b', incomplete: true }, { id: 'c' }],
      })
    ).toBe('2');
  });
});

describe('gate wiring', () => {
  it('turns an abandoned prompt into a breach, not just a log line', () => {
    // The `|| ABANDONED -gt 0` arm is what makes a timed-out prompt a breach even when the
    // surviving prompts average under threshold - the 2026-09-18 shape.
    expect(yaml).toContain('elif [ "$IS_OVER" = "1" ] || [ "${ABANDONED:-0}" -gt 0 ]; then');
    expect(yaml).toContain('EXCEEDED=true');
    expect(yaml).toContain('prompt(s) never finished');
  });

  it('publishes one skip-aware breach verdict for every consumer', () => {
    // Both the Slack page and the run gate must read the same output; a second copy of
    // "exceeded && not skipped" is what drifts.
    expect(yaml).toContain('echo "latency_breach=$LATENCY_BREACH" >> $GITHUB_OUTPUT');
    const consumers = yaml.match(/steps\.aggregate\.outputs\.latency_breach == 'true'/g) ?? [];
    expect(consumers.length).toBeGreaterThanOrEqual(2);
  });

  it('sets the breach only inside the skip guard', () => {
    // Placement, not presence: hoisting LATENCY_BREACH=true one line out of this block reds a run
    // that skipped for a missing repo secret - a cell that produced no latency data at all.
    const guard = 'if [ "$EXCEEDED" = "true" ] && [ "${PREVIEW_SKIPPED:-}" != "true" ]; then';
    expect(yaml).toContain(guard);
    const block = yaml.slice(yaml.indexOf(guard), yaml.indexOf('\n          fi', yaml.indexOf(guard)));
    expect(block).toContain('LATENCY_BREACH=true');
    // Initialised false outside the guard, so the output is always defined.
    expect(yaml.slice(0, yaml.indexOf(guard))).toMatch(/\n\s+LATENCY_BREACH=false\n/);
    expect(yaml.match(/LATENCY_BREACH=true/g) ?? []).toHaveLength(1);
  });

  it('fails the run on a breach', () => {
    const step = yaml.slice(yaml.indexOf(GATE_STEP));
    expect(step).toContain("if: ${{ always() && steps.aggregate.outputs.latency_breach == 'true' }}");
    expect(step).toMatch(/\n\s+exit 1\b/);
  });

  it('names both breach causes in the error it prints', () => {
    // latency_breach also fires on the abandoned arm with the average under threshold, so an
    // "average exceeded" message alone would send triage after the wrong number.
    const message = yaml.slice(yaml.indexOf(GATE_STEP)).match(/echo "::error::([^"]+)"/)?.[1] ?? '';
    expect(message).toMatch(/threshold/i);
    expect(message).toMatch(/abandon|never finished|streaming cap/i);
  });

  it('keeps the gate after the Slack steps so a red run is still announced', () => {
    const gate = yaml.indexOf(GATE_STEP);
    expect(gate).toBeGreaterThan(yaml.indexOf('- name: Send Slack notification'));
    expect(gate).toBeGreaterThan(yaml.indexOf('- name: Send Slack alert for latency threshold breach'));
  });

  it('runs only on schedule/dispatch, so the gate cannot red a PR check', () => {
    // If this ever gains `pull_request`, the blast radius of the gate changes completely.
    const header = yaml.slice(0, yaml.indexOf('jobs:'));
    expect(header).not.toMatch(/^\s{2}pull_request:/m);
  });
});
