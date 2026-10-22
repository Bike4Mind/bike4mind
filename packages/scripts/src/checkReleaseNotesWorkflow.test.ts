import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard: the release-notes steps in prod-release.yml stay best-effort and gated.
 *
 * prod-release.yml only runs on dispatch, so a broken `if:` or a dropped `continue-on-error`
 * would first show up as a failed (or unexpectedly enqueuing) production release. Text-matched
 * like the sibling workflow guards: the repo carries no YAML parser dependency.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'prod-release.yml'), 'utf8');

const GATE =
  "if: success() && vars.RELEASE_NOTES_ENABLED == 'true' && github.event.inputs.dry_run != 'true' && steps.create.outputs.release_tag != ''";
// continue-on-error keeps success() true when the assume fails, and the deploy role's credentials are
// still in the env then, so the enqueue must also require the release-notes role step to have succeeded.
const ENQUEUE_GATE = `${GATE} && steps.release-notes-creds.outcome == 'success'`;

/** The text of one step, from its `- name:` line up to the next step. */
function stepBlock(name: string): string {
  const start = yaml.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`step not found in prod-release.yml: ${name}`);
  const next = yaml.indexOf('\n      - name: ', start + 1);
  return yaml.slice(start, next === -1 ? undefined : next);
}

const STEPS = ['Configure AWS credentials for release notes', 'Enqueue release notes'];

describe('prod-release.yml release-notes steps', () => {
  it('gives the release step the id the gate reads its output from', () => {
    expect(stepBlock('Create production release')).toMatch(/^\s+id: create$/m);
  });

  it.each([
    [STEPS[0], GATE],
    [STEPS[1], ENQUEUE_GATE],
  ])('%s carries the full gate and continue-on-error', (name, gate) => {
    const block = stepBlock(name);
    expect(block.split('\n').map(l => l.trim())).toContain(gate);
    expect(block).toMatch(/^\s+continue-on-error: true$/m);
  });

  it('gives the release-notes credentials step the id the enqueue gate reads', () => {
    expect(stepBlock(STEPS[0])).toMatch(/^\s+id: release-notes-creds$/m);
  });

  it('runs both steps after the release is created', () => {
    const created = yaml.indexOf('- name: Create production release\n');
    for (const name of STEPS) expect(yaml.indexOf(`- name: ${name}\n`)).toBeGreaterThan(created);
  });

  it('assumes the release-notes role and passes the queue URL and tag to the enqueue script', () => {
    expect(stepBlock(STEPS[0])).toContain('role-to-assume: ${{ secrets.AWS_RELEASE_NOTES_ROLE_ARN }}');
    const enqueue = stepBlock(STEPS[1]);
    expect(enqueue).toContain('RELEASE_NOTES_QUEUE_URL: ${{ secrets.RELEASE_NOTES_QUEUE_URL }}');
    expect(enqueue).toContain('RELEASE_TAG: ${{ steps.create.outputs.release_tag }}');
    expect(enqueue).toContain('release-notes:enqueue --tag "$RELEASE_TAG"');
  });
});
