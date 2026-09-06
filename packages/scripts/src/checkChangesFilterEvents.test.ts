import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-check ci.yml's trigger list against the changes-filter action's event dispatch.
 *
 * The action picks its diff range from a `case "$EVENT_NAME"` block, and falls through to a `*)`
 * arm that blanks the range - which trips the action's own fail-open guard and forces
 * deployable=true + docs-changed=true. That is the right call for a genuinely unresolvable range
 * (force-push, brand-new branch). It is the wrong call for an event that simply has no arm,
 * because then EVERY run of that trigger fails open, permanently, and the run looks entirely
 * normal: nothing errors, some extra jobs just run. `merge_group` sat in that state, so the merge
 * queue gated on a different signal than the PR's own CI - a queue run could fail a leg the PR
 * legitimately skipped, ejecting the PR with no reproduction on the author's branch.
 *
 * Nothing else can catch this. The action only ever executes inside a real workflow run, and the
 * `merge_group` path specifically cannot be reached from a `pull_request` run, so the PR that adds
 * a trigger to ci.yml is green regardless of what the action does with it. Hence a static
 * cross-check: every trigger ci.yml declares must have its own arm, and every env var an arm reads
 * must be plumbed into the step's `env:` block and bound to that event's own payload. That second
 * half is not redundant - an arm on its own is a no-op, reading unset variables and failing open
 * exactly as before.
 *
 * Deliberately letting an event fail open is still allowed: write the arm explicitly
 * (`BASE=""; HEAD=""`) so the decision is visible in the action rather than inherited by silence.
 *
 * Text-matched rather than YAML-parsed on purpose - the repo carries no YAML parser dependency,
 * and the assertion wanted is over literal mapping keys and shell arm labels anyway.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const CHANGES_FILTER = path.join(REPO_ROOT, '.github', 'actions', 'changes-filter', 'action.yml');

/**
 * Top-level event names from a workflow's `on:` block.
 *
 * Requires the block-mapping form (`on:` on its own line, trigger keys two spaces in). The
 * flow-sequence form (`on: [push, pull_request]`) yields nothing, which the "non-empty" test below
 * turns into a loud failure rather than a guard that silently passes over an unparsed block.
 * Comment lines are skipped instead of ending the block, so a column-0 comment inside `on:` cannot
 * truncate the list either.
 */
function readWorkflowTriggers(contents: string): string[] {
  const lines = contents.split('\n');
  const start = lines.findIndex(line => /^on:\s*$/.test(line));
  if (start === -1) return [];

  const triggers: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z_]+):/.exec(line);
    if (match) triggers.push(match[1]);
  }
  return triggers;
}

/**
 * Arms of the action's `case "$EVENT_NAME"` dispatch, each with its labels and body lines.
 *
 * Comment lines are dropped before labels are matched. The sibling shard guard learned this the
 * hard way in reverse: prose that happens to fit the pattern must not count as a declaration, and
 * these arms carry several paragraphs of it.
 */
function readCaseArms(contents: string): Array<{ labels: string[]; body: string }> {
  const block = /case\s+"\$EVENT_NAME"\s+in\n([\s\S]*?)\n\s*esac/.exec(contents);
  if (!block) return [];

  const arms: Array<{ labels: string[]; body: string }> = [];
  for (const line of block[1].split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const label = /^\s*([a-z_*]+(?:\|[a-z_*]+)*)\)/.exec(line);
    if (label) {
      arms.push({ labels: label[1].split('|'), body: `${line}\n` });
    } else if (arms.length > 0) {
      arms[arms.length - 1].body += `${line}\n`;
    }
  }
  return arms;
}

/**
 * Env bindings declared on the composite step, as key -> value expression (6-space `env:`, keys 8
 * spaces in). The value is half the contract: a key bound to another event's payload is declared
 * yet still expands empty on the event whose arm reads it.
 */
function readStepEnvBindings(contents: string): Array<{ key: string; value: string }> {
  const lines = contents.split('\n');
  const start = lines.findIndex(line => /^ {6}env:\s*$/.test(line));
  if (start === -1) return [];

  const bindings: Array<{ key: string; value: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^ {8}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) break;
    bindings.push({ key: match[1], value: match[2].trim() });
  }
  return bindings;
}

/** Env keys declared on the composite step (6-space `env:`, keys 8 spaces in). */
function readStepEnvKeys(contents: string): string[] {
  return readStepEnvBindings(contents).map(binding => binding.key);
}

/** Shell variable names an arm body reads, as `$NAME` or `${NAME}`. */
function readEnvRefs(body: string): string[] {
  return [...body.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)].map(match => match[1]);
}

/**
 * Names assigned inside the dispatch itself (BASE, HEAD). Subtracted from the env-plumbing check
 * so an arm reading a value another arm set is not mistaken for a missing env var.
 */
function readAssignedNames(contents: string): string[] {
  const block = /case\s+"\$EVENT_NAME"\s+in\n([\s\S]*?)\n\s*esac/.exec(contents);
  if (!block) return [];
  return [...block[1].matchAll(/(?:^|;)\s*([A-Z_][A-Z0-9_]*)=/gm)].map(match => match[1]);
}

describe('changes-filter event dispatch vs ci.yml triggers', () => {
  const ci = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const action = fs.readFileSync(CHANGES_FILTER, 'utf8');
  const triggers = readWorkflowTriggers(ci);
  const arms = readCaseArms(action);
  const handled = new Set(arms.flatMap(arm => arm.labels));

  it('parses a non-empty trigger list out of ci.yml', () => {
    expect(triggers, "no triggers parsed from ci.yml's `on:` block").not.toHaveLength(0);
  });

  it('parses a non-empty case block out of the action', () => {
    expect(arms, "no arms parsed from the action's $EVENT_NAME dispatch").not.toHaveLength(0);
  });

  it('gives every event ci.yml triggers on its own arm', () => {
    expect(
      triggers.filter(trigger => !handled.has(trigger)),
      'ci.yml triggers with no arm in the changes-filter case block; each one fails open on every run of that trigger'
    ).toEqual([]);
  });

  it('keeps the fail-open default arm as the safety net', () => {
    expect(handled.has('*'), 'the `*)` arm is what catches an event nobody anticipated').toBe(true);

    const fallback = arms.find(arm => arm.labels.includes('*'));
    const blanksRange =
      'the `*)` safety net must blank the range, not just exist; any other range diffs the wrong commits';
    expect(fallback?.body, blanksRange).toMatch(/BASE=""/);
    expect(fallback?.body, blanksRange).toMatch(/HEAD=""/);
  });

  it('plumbs every env var the arms read through the step env block', () => {
    const declared = new Set(readStepEnvKeys(action));
    const assigned = new Set(readAssignedNames(action));
    const missing = arms
      .flatMap(arm => readEnvRefs(arm.body))
      .filter(name => !declared.has(name) && !assigned.has(name));
    expect(
      [...new Set(missing)],
      "vars read by a case arm but absent from the step's `env:` block; they expand empty and fail open"
    ).toEqual([]);
  });

  it("binds each event's SHA vars to that event's own payload", () => {
    const misbound = readStepEnvBindings(action).filter(({ key, value }) => {
      if (key.startsWith('MERGE_GROUP_')) return !value.includes('github.event.merge_group.');
      if (key.startsWith('PR_')) return !value.includes('github.event.pull_request.');
      if (key.startsWith('PUSH_')) return !/github\.event\.(before|after)/.test(value);
      return false;
    });
    expect(
      misbound.map(({ key, value }) => `${key}: ${value}`),
      "env keys wired to another event's payload; declared, but empty on the event whose arm reads them"
    ).toEqual([]);
  });
});

describe('readWorkflowTriggers', () => {
  it('reads the trigger keys and ignores their nested config', () => {
    const triggers = readWorkflowTriggers(
      ['on:', '  push:', '    branches: [main]', '  merge_group:', '    branches: [main]', '', 'env:', '  X: 1'].join(
        '\n'
      )
    );
    expect(triggers).toEqual(['push', 'merge_group']);
  });

  it('ignores comments inside the block instead of stopping at them', () => {
    const triggers = readWorkflowTriggers(
      ['on:', '  push:', '# a column-0 comment', '  merge_group:', 'env:'].join('\n')
    );
    expect(triggers).toEqual(['push', 'merge_group']);
  });

  it('stops at the next top-level key', () => {
    expect(readWorkflowTriggers(['on:', '  push:', 'jobs:', '  build:'].join('\n'))).toEqual(['push']);
  });

  it('finds nothing in the flow-sequence form, so the non-empty assertion fires', () => {
    expect(readWorkflowTriggers('on: [push, pull_request]\n')).toEqual([]);
  });
});

describe('readCaseArms', () => {
  const dispatch = (...lines: string[]) => ['        case "$EVENT_NAME" in', ...lines, '        esac'].join('\n');

  it('reads labels and bodies', () => {
    const arms = readCaseArms(
      dispatch('          push)', '            BASE="$PUSH_BEFORE" ;;', '          *)', '            BASE="" ;;')
    );
    expect(arms.map(arm => arm.labels)).toEqual([['push'], ['*']]);
    expect(arms[0].body).toContain('PUSH_BEFORE');
  });

  it('splits an alternation label into both events', () => {
    const arms = readCaseArms(dispatch('          push|merge_group)', '            BASE="$X" ;;'));
    expect(arms[0].labels).toEqual(['push', 'merge_group']);
  });

  it('does not count a label-shaped phrase inside a comment as an arm', () => {
    const arms = readCaseArms(
      dispatch('          # merge_group) used to be missing here', '          push)', '            BASE="$X" ;;')
    );
    expect(arms.map(arm => arm.labels)).toEqual([['push']]);
  });

  // The pre-fix shape: push and pull_request handled, merge_group left to the default arm. This
  // pins how readCaseArms reports that shape - it rebuilds the comparison rather than calling it,
  // so the guard itself is asserted only by the live cross-check above, against the real files.
  it('reports merge_group as unhandled when only push and pull_request have arms', () => {
    const arms = readCaseArms(
      dispatch(
        '          push)',
        '            BASE="$PUSH_BEFORE" ;;',
        '          pull_request)',
        '            BASE="$PR_BASE_SHA" ;;',
        '          *)',
        '            BASE=""; HEAD="" ;;'
      )
    );
    const handled = new Set(arms.flatMap(arm => arm.labels));
    expect(handled.has('merge_group')).toBe(false);
  });

  it('finds nothing when the dispatch is absent', () => {
    expect(readCaseArms('runs:\n  using: composite\n')).toEqual([]);
  });
});

describe('readStepEnvBindings', () => {
  it('pairs each key with its value expression and stops at the next step key', () => {
    const bindings = readStepEnvBindings(
      [
        '    - id: filter',
        '      env:',
        '        EVENT_NAME: ${{ github.event_name }}',
        '        # a comment between keys does not end the block',
        '        MERGE_GROUP_HEAD_SHA: ${{ github.event.merge_group.head_sha || github.sha }}',
        '      run: |',
        '        set -euo pipefail',
      ].join('\n')
    );
    expect(bindings).toEqual([
      { key: 'EVENT_NAME', value: '${{ github.event_name }}' },
      { key: 'MERGE_GROUP_HEAD_SHA', value: '${{ github.event.merge_group.head_sha || github.sha }}' },
    ]);
  });
});

describe('readStepEnvKeys', () => {
  it('reads the step env keys and stops at the next step key', () => {
    const keys = readStepEnvKeys(
      [
        '    - id: filter',
        '      env:',
        '        EVENT_NAME: ${{ github.event_name }}',
        '        PUSH_BEFORE: ${{ github.event.before }}',
        '      run: |',
        '        set -euo pipefail',
      ].join('\n')
    );
    expect(keys).toEqual(['EVENT_NAME', 'PUSH_BEFORE']);
  });
});

describe('readEnvRefs', () => {
  it('picks up both the bare and braced forms and skips lowercase locals', () => {
    expect(readEnvRefs('BASE="$MERGE_GROUP_BASE_SHA"; HEAD="${MERGE_GROUP_HEAD_SHA}"; x="$local"')).toEqual([
      'MERGE_GROUP_BASE_SHA',
      'MERGE_GROUP_HEAD_SHA',
    ]);
  });
});
