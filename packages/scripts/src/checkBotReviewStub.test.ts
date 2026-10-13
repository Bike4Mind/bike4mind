import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on the caller stub for the org's reusable PR review workflow.
 *
 * The reusable's own suite (Bike4Mind/workflow-templates, checkBotFoldWritePath.test.mjs) cannot
 * see this file, so the stub's trigger, pin and label gate are pinned here. With
 * `secrets: inherit`, a floating ref would put every workflow-templates merge live in this repo
 * with this repo's secrets, and a `pull_request_target` trigger would run an agent over an
 * untrusted head with them.
 *
 * Text-matched rather than YAML-parsed, following checkClientTestShards.test.ts's precedent.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STUB = path.join(REPO_ROOT, '.github', 'workflows', 'pr-bot-review.yml');

const stub = fs.readFileSync(STUB, 'utf8');
const lines = stub.split('\n').filter(line => !line.trimStart().startsWith('#'));

describe('pr-bot-review caller stub', () => {
  it('triggers on pull_request only, never pull_request_target', () => {
    const code = lines.join('\n');
    expect(code).toMatch(/^on:\n {2}pull_request:\n {4}types: \[labeled\]$/m);
    expect(code).not.toMatch(/pull_request_target/);
  });

  it('pins the reusable workflow to a full commit SHA', () => {
    const uses = lines.filter(line => /^\s+uses:/.test(line));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(
      /^\s+uses: Bike4Mind\/workflow-templates\/\.github\/workflows\/pr-bot-review\.yml@[0-9a-f]{40}$/
    );
  });

  it('gates the job on exactly the two bot labels', () => {
    const gates = lines.filter(line => /^\s+if:/.test(line));
    expect(gates).toEqual([
      "    if: github.event.label.name == 'bot-review' || github.event.label.name == 'bot-review-fold'",
    ]);
  });
});
