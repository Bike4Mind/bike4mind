import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards the CI-wiring gap in #2210: .husky/check-help-content.sh enforces the Help AI chat's
 * "every indexed article has a vector" invariant, but a diff that touches ONLY that file is
 * `deployable=false` (`.husky/**` is on changes-filter's exclude list) AND `docs-changed=false`
 * (docs-paths only covers docs-site/**), so every job gated on either flag skips - and a skipped
 * required check counts as passing. Nothing in CI would ever run the script on a diff shaped
 * exactly like an edit to itself.
 *
 * check-help-content-guard.yml closes that by running the script unconditionally, gated only on
 * its own `paths:` filter (the same pattern gitleaks-config-guard.yml uses for .gitleaks.toml).
 * This test pins that the guard workflow exists, actually watches the script, and runs it with no
 * `if:` gate tied to the shared changes-filter outputs - so a future edit can't quietly reintroduce
 * the gap by adding a `needs.changes` condition or dropping the path from the trigger.
 *
 * Text-matched rather than YAML-parsed, following checkClientTestShards.test.ts's precedent: the
 * repo has no YAML parser dependency, and a diff that only touches the guarded script never reaches
 * a real GitHub Actions run in this test suite anyway - the trigger's own `paths:` list is the thing
 * under test.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'check-help-content-guard.yml');
const GUARDED_SCRIPT = '.husky/check-help-content.sh';

describe('check-help-content-guard.yml', () => {
  it('exists', () => {
    expect(fs.existsSync(GUARD_WORKFLOW), `expected ${GUARD_WORKFLOW} to exist`).toBe(true);
  });

  const contents = fs.existsSync(GUARD_WORKFLOW) ? fs.readFileSync(GUARD_WORKFLOW, 'utf8') : '';

  it('triggers on a pull_request paths filter that names the guarded script', () => {
    const pullRequestBlock = contents.match(/pull_request:\n(?:[ \t]+.*\n)+/)?.[0] ?? '';
    expect(pullRequestBlock).toContain('paths:');
    expect(pullRequestBlock).toContain(GUARDED_SCRIPT);
  });

  it('also triggers on merge_group, so the check reports there if it becomes required', () => {
    expect(contents).toMatch(/^\s*merge_group:\s*$/m);
  });

  it('runs the guarded script with no if: gate on the shared changes-filter outputs', () => {
    const runLineIndex = contents.split('\n').findIndex(line => line.includes(`sh ${GUARDED_SCRIPT}`));
    expect(runLineIndex, `expected a run step invoking sh ${GUARDED_SCRIPT}`).toBeGreaterThanOrEqual(0);
    // The whole point: this must NOT be reachable only through `needs.changes.outputs.deployable`
    // or `docs-changed` - that is exactly the condition that made the script unreachable before.
    expect(contents).not.toMatch(/if:.*needs\.changes\.outputs\.(deployable|docs-changed)/);
  });
});
