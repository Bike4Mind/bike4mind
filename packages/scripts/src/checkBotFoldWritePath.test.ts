import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard: how a `bot-fold` run is allowed to write to a PR branch.
 *
 * The review agent in `pr-bot-review.yml` reads untrusted PR, issue and comment text on a
 * public repo, so it deliberately has no shell. Fold mode widens it to the file-write tools
 * so it can apply its own findings - and that is the whole of the widening. Deciding WHAT to
 * change stays with the agent; making the change durable is a plain `run:` step, which is what
 * keeps the destination ref and the force-push choice out of the agent's reach as a matter of
 * construction rather than of prose.
 *
 * Nothing else can catch a regression here. The fold path cannot be exercised before a change
 * to this file merges: claude-code-action validates the calling workflow against the
 * DEFAULT-BRANCH copy and no-ops with a successful exit when they differ, so labelling the PR
 * that edits it does nothing and labelling any other PR runs main's copy. A fold run is also
 * expensive and mutates a branch, so it is not something CI can rehearse. These assertions are
 * the only pre-merge evidence the invariants still hold.
 *
 * Text-matched rather than YAML-parsed, matching the sibling guards: the repo carries no YAML
 * parser dependency and adding one for a workflow assertion is not worth the supply chain.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'pr-bot-review.yml');

/** The value of a `--allowedTools` / `--disallowedTools` flag, unquoted, in file order. */
function toolFlagValues(src: string, flag: string): string[] {
  return [...src.matchAll(new RegExp(`^\\s*--${flag} "(.*)"\\s*$`, 'gm'))].map(m => m[1]);
}

/**
 * The branches of a `${{ cond && 'a' || 'b' }}` ternary inside one flag value, plus any literal
 * text outside it. Both modes must be checked, and a single-mode file has exactly one branch.
 */
function toolListBranches(value: string): string[] {
  const ternary = value.match(/\$\{\{[^}]*?&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}/);
  if (!ternary) return [value];
  const literal = value.replace(ternary[0], '');
  return [literal + ternary[1], literal + ternary[2]];
}

describe('bot-fold write path', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');

  it('denies Bash in every mode, and grants it in none', () => {
    const denied = toolFlagValues(src, 'disallowedTools');
    expect(denied).toHaveLength(1);
    const deniedBranches = toolListBranches(denied[0]);
    // Two branches: review mode and fold mode. One branch means the mode split was lost.
    expect(deniedBranches).toHaveLength(2);
    for (const branch of deniedBranches) {
      expect(branch.split(',')).toContain('Bash');
    }

    const allowed = toolFlagValues(src, 'allowedTools');
    expect(allowed).toHaveLength(1);
    for (const branch of toolListBranches(allowed[0])) {
      expect(branch.split(',')).not.toContain('Bash');
    }
  });

  it('grants the file-write tools on exactly one of the two modes', () => {
    const [reviewDeny, foldDeny] = toolListBranches(toolFlagValues(src, 'disallowedTools')[0])
      .map(branch => branch.split(','))
      .sort((a, b) => b.length - a.length);
    // Deny beats allow, so the deny list is the side that actually decides this.
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(reviewDeny).toContain(tool);
      expect(foldDeny).not.toContain(tool);
    }
    // The two modes differ by those three names and nothing else.
    expect(reviewDeny.filter(tool => !foldDeny.includes(tool)).sort()).toEqual(['Edit', 'MultiEdit', 'Write']);
  });

  it('never tells the agent to push', () => {
    // The push belongs to a `run:` step. Anything inside the review step's `prompt:` or
    // `claude_args:` is instruction to a model that has no shell to carry it out with, so a
    // `git push` there is either dead prose or a request to find a way around the tool fence.
    const reviewStep = src.match(/^ {6}- name: Run \/bot-review$[\s\S]*?^ {6}- name: /m)?.[0];
    expect(reviewStep).toBeTruthy();
    expect(reviewStep).not.toMatch(/git push/);
  });

  it('mints the fold token with both the permissions a push needs', () => {
    const mintStep = src.match(/^ {6}- name: Mint fold push token[\s\S]*?^ {6}- name: /m)?.[0];
    expect(mintStep).toBeTruthy();
    expect(mintStep).toMatch(/^\s*permission-contents: write$/m);
    // Without this a fold touching .github/workflows/** is rejected at push time.
    expect(mintStep).toMatch(/^\s*permission-workflows: write$/m);
  });

  it('pushes non-force to the PR head ref, with a token the checkout never held', () => {
    const pushStep = src.match(/^ {6}- name: Push fold commit$[\s\S]*?^ {6}- name: /m)?.[0];
    expect(pushStep).toBeTruthy();
    // Scoped to the invocation itself. Anchored on `$(git push` rather than on `git push`,
    // because the step's own comment quotes `git push origin` while explaining why we do not
    // use it - and that comment also contains the word `--force`.
    const pushCmd = (pushStep ?? '').match(/\$\(git push [\s\S]*?refs\/heads\/\$\{HEAD_REF\}"/)?.[0] ?? '';
    expect(pushCmd).not.toBe('');
    expect(pushCmd).not.toMatch(/--force|(?:^|\s)-f(?:\s|$)|\+HEAD/);
    // The checkout must not leave a credential in .git/config for anything to reach.
    expect(src).toMatch(/^\s*persist-credentials: false$/m);
  });

  it('gates every bot-review label site on bot-fold too', () => {
    // The class of bug this catches: a gate that still reads `== 'bot-review'` alone silently
    // skips its step on a fold run. `Remove re-review label` is the one that bites hardest -
    // an untwinned gate leaves the fold label attached, so the next label add is a no-op.
    const sites = src.split('\n').filter(line => line.includes("github.event.label.name == 'bot-review'"));
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site).toContain('bot-fold');
    }
    // And the label removed is the one that fired, never a hardcoded name - carried
    // through env rather than spliced into the `run:` body, which is the shape of an
    // Actions script injection.
    expect(src).toMatch(/^\s*LABEL: \$\{\{ github\.event\.label\.name \}\}$/m);
    expect(src).toMatch(/--remove-label "\$LABEL"/);
    expect(src).not.toMatch(/--remove-label (bot-review|bot-fold)\b/);
  });

  it('does not cancel a fold run in flight', () => {
    // A cancel between a successful push and the end of the job leaves a bot commit with no
    // review explaining it: neither the review-posted check nor the label removal runs on a
    // `cancelled` outcome.
    const block = src.match(/^concurrency:\n(?:(?: {2}.*)?\n)+/m)?.[0] ?? '';
    expect(block).toMatch(/^ {2}cancel-in-progress: \$\{\{ github\.event\.label\.name != 'bot-fold' \}\}$/m);
  });
});
