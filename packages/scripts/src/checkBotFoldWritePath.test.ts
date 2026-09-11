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
 * keeps the destination ref, the force-push choice and the set of paths a fold may touch out of
 * the agent's reach as a matter of construction rather than of prose.
 *
 * Nothing else can catch a regression here. The fold path cannot be exercised before a change
 * to this file merges: claude-code-action validates the calling workflow against the
 * DEFAULT-BRANCH copy and no-ops with a successful exit when they differ, so labelling the PR
 * that edits it does nothing and labelling any other PR runs main's copy. A fold run is also
 * expensive and mutates a branch, so it is not something CI can rehearse. These assertions are
 * the only pre-merge evidence the invariants still hold, so they pin the antecedent (`FOLD_MODE`
 * itself) as well as the consequents, and every one of them is scoped to the step it is about.
 *
 * Text-matched rather than YAML-parsed, matching the sibling guards: the repo carries no YAML
 * parser dependency and adding one for a workflow assertion is not worth the supply chain.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'pr-bot-review.yml');

/**
 * One `- name: X` step, from its name line up to the next step at the same indent - or to the
 * end of the file, since the last step in the job has no following step to stop at.
 */
function step(src: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = src.match(new RegExp(`^ {6}- name: ${escaped}.*$[\\s\\S]*?(?=^ {6}- name: |$(?![\\s\\S]))`, 'm'))?.[0];
  expect(found, `step not found: ${name}`).toBeTruthy();
  return found ?? '';
}

/** A step's `run:` body with comment-only lines dropped, so prose cannot satisfy an assertion. */
function runCommands(stepSrc: string): string {
  return stepSrc
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

/** The value of a `--allowedTools` / `--disallowedTools` flag, unquoted, in file order. */
function toolFlagValues(src: string, flag: string): string[] {
  return [...src.matchAll(new RegExp(`^\\s*--${flag} "(.*)"\\s*$`, 'gm'))].map(m => m[1]);
}

/**
 * Splits one tool-flag value on its `${{ cond && 'a' || 'b' }}` mode ternary. The arms are
 * identified by POLARITY, never by length: labelling them by which list is longer is what let an
 * inverted condition read as correct. The condition is returned so it can be asserted too.
 */
function toolListModes(value: string): { condition: string; fold: string[]; review: string[] } {
  const ternary = value.match(/\$\{\{(.*?)&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}/);
  // Thrown rather than expect()ed: a missing ternary means the mode split itself is gone, and
  // every assertion downstream of here would be meaningless rather than merely failing.
  if (!ternary) throw new Error(`no mode ternary in tool list: ${value}`);
  const [whole, condition, trueArm, falseArm] = ternary;
  const literal = value.replace(whole, '');
  const names = (branch: string) => branch.split(',').filter(Boolean);
  return {
    condition,
    fold: names(literal + trueArm),
    review: names(literal + falseArm),
  };
}

describe('bot-fold write path', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');

  it('derives FOLD_MODE from the bot-fold label and nothing else', () => {
    // The antecedent every other assertion here is written in terms of. Hardcoding this to
    // 'true' - the obvious way to try to exercise a path that cannot otherwise be rehearsed -
    // gives every `bot-review` label the write tools, a write token and a push to the PR head.
    expect(src).toMatch(/^ {6}FOLD_MODE: \$\{\{ github\.event\.label\.name == 'bot-fold' \}\}$/m);
    expect(src.match(/^ *FOLD_MODE:/gm)).toHaveLength(1);
  });

  it('denies Bash in every mode, and grants it in none', () => {
    const denied = toolFlagValues(src, 'disallowedTools');
    expect(denied).toHaveLength(1);
    const deny = toolListModes(denied[0]);
    expect(deny.condition).toMatch(/env\.FOLD_MODE == 'true'/);
    expect(deny.fold).toContain('Bash');
    expect(deny.review).toContain('Bash');

    const allowed = toolFlagValues(src, 'allowedTools');
    expect(allowed).toHaveLength(1);
    const allow = toolListModes(allowed[0]);
    expect(allow.condition).toMatch(/env\.FOLD_MODE == 'true'/);
    expect(allow.fold).not.toContain('Bash');
    expect(allow.review).not.toContain('Bash');
  });

  it('grants the file-write tools on the fold mode only', () => {
    // Deny beats allow, so the deny list is the side that actually decides this.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(deny.review).toContain(tool);
      expect(deny.fold).not.toContain(tool);
    }
    // The two modes differ by those three names and nothing else.
    expect(deny.review.filter(tool => !deny.fold.includes(tool)).sort()).toEqual([
      'Edit',
      'MultiEdit',
      'Write',
    ]);
  });

  it('never tells the agent to push', () => {
    // The push belongs to a `run:` step. Anything inside the review step's `prompt:` or
    // `claude_args:` is instruction to a model that has no shell to carry it out with, so a
    // `git push` there is either dead prose or a request to find a way around the tool fence.
    const reviewStep = step(src, 'Run /bot-review');
    expect(reviewStep).not.toMatch(/git push/);
  });

  it('tells the agent what FOLD_MODE actually is', () => {
    // The agent has no shell and `Read(//proc/**)` is denied, so it cannot read the process
    // environment. Without this interpolation the prompt's own rule ("anything else, including
    // unset, means review only") makes a fold run change nothing at all, silently.
    const reviewStep = step(src, 'Run /bot-review');
    expect(reviewStep).toMatch(/FOLD_MODE is '\$\{\{ env\.FOLD_MODE \}\}'/);
  });

  it('mints the fold token with contents: write and no workflow scope', () => {
    const mintStep = step(src, 'Mint fold push token');
    expect(mintStep).toMatch(/^\s*permission-contents: write$/m);
    // Not the control - the push step's path guard is - but withholding the scope is the
    // defence in depth behind it, and re-adding it widens the blast radius of a guard bug.
    expect(mintStep).not.toMatch(/permission-workflows/);
  });

  it('mints and pushes only on a non-cancelled run that posted a review', () => {
    // `always()` is true on cancellation, so it would leave both steps eligible to mint a token
    // and commit on a run the user stopped. And a fold commit whose message points at a review
    // that was never posted is worse than no fixup: gate on the measurement, not on the exit code.
    for (const name of ['Mint fold push token', 'Push fold commit', 'Report fold failure']) {
      const gate = step(src, name).match(/^ {8}if: \|\n(?: {10}.*\n)+/m)?.[0];
      expect(gate, `${name}: no block-scalar if:`).toBeTruthy();
      expect(gate).toMatch(/!cancelled\(\)/);
      expect(gate).not.toMatch(/always\(\)/);
      expect(gate).toMatch(/env\.FOLD_MODE == 'true'/);
    }
    expect(step(src, 'Mint fold push token')).toMatch(
      /steps\.review_posted\.outputs\.posted == 'true'/
    );
  });

  it('refuses to commit a file CI executes', () => {
    // The push carries an App token on purpose, so it DOES trigger workflows - which run tracked
    // scripts in steps holding write tokens. `git add -u` bounds the commit to tracked files; this
    // guard is the only thing bounding it by path, and without it injected text in a public PR
    // comment becomes code execution on the next `synchronize`.
    const commands = runCommands(step(src, 'Push fold commit'));
    const guard = commands.match(/BLOCKED=\$\(git diff --cached --name-only \| grep -E[\s\S]*?\|\| true\)/)?.[0];
    expect(guard, 'no staged-path guard in the push step').toBeTruthy();
    for (const pattern of ['.github', '.husky', '.claude', 'scripts', 'infra', 'package\\.json', 'sh']) {
      expect(guard).toContain(pattern);
    }
    // Refuse the whole fixup rather than committing the acceptable subset. Scoped to the `if`
    // block's own `fi`, so a stray `exit 1` from a later block cannot stand in for this one.
    const refusal = commands.match(/^ {10}if \[ -n "\$BLOCKED" \]; then\n[\s\S]*?^ {10}fi$/m)?.[0];
    expect(refusal, 'the blocked-path branch does not refuse').toBeTruthy();
    expect(refusal).toMatch(/^ {12}exit 1$/m);
    // And it has to run before the commit, not after it.
    expect(commands.indexOf('BLOCKED=')).toBeLessThan(commands.indexOf('git commit'));

    // Same principle, on volume rather than path: a fold applies review findings, so a sprawling
    // diff means something else happened. Asserted so the bound cannot decay into a log line.
    const sizeBound = commands.match(/^ {10}if \[ "\$CHANGED" -gt \d+ \]; then\n[\s\S]*?^ {10}fi$/m)?.[0];
    expect(sizeBound, 'no diff-size bound in the push step').toBeTruthy();
    expect(sizeBound).toMatch(/^ {12}exit 1$/m);
    expect(commands.indexOf('CHANGED=')).toBeLessThan(commands.indexOf('git commit'));
  });

  it('pushes non-force to the PR head ref, with a token the checkout never held', () => {
    // Scoped to the commands, not the step text: the step's own comments quote `git push origin`
    // while explaining why we do not use it, and that comment contains the word `--force` too.
    const commands = runCommands(step(src, 'Push fold commit'));
    // Every invocation, not just the first: a second `git push --force ... main` appended to the
    // same step is exactly the regression a first-match anchor waves through.
    expect(commands.match(/git push/g)).toHaveLength(1);
    expect(commands).not.toMatch(/--force|(?:^|\s)-f(?:\s|$)|\+HEAD/);
    // One ref, and it is the one the PR came from.
    expect(commands.match(/refs\/heads\/\S+/g)).toEqual(['refs/heads/${HEAD_REF}"']);

    // The checkout must not leave a credential in .git/config for anything to reach. Scoped to
    // the step, plus a file-wide check so a second checkout cannot persist one either.
    expect(step(src, 'Checkout PR head')).toMatch(/^\s*persist-credentials: false$/m);
    expect(src).not.toMatch(/persist-credentials: true/);
  });

  it('gates every bot-review label site on bot-fold too', () => {
    // The class of bug this catches: a gate that still reads `== 'bot-review'` alone silently
    // skips its step on a fold run. `Remove re-review label` is the one that bites hardest -
    // an untwinned gate leaves the fold label attached, so the next label add is a no-op. It is
    // asserted by name rather than counted among the matches, so a rewrite of its condition
    // cannot drop it out of the denominator.
    expect(step(src, 'Remove re-review label')).toMatch(
      /if: .*github\.event\.label\.name == 'bot-review' \|\| github\.event\.label\.name == 'bot-fold'/
    );
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

  it('never lets a fold run cancel the review run it arrives alongside', () => {
    // Deliberately not named "does not cancel a fold run in flight": `cancel-in-progress` is
    // evaluated on the INCOMING run and the group key carries no mode, so this line cannot
    // protect a fold run from being cancelled. The `!cancelled()` gates above do that.
    const block = src.match(/^concurrency:\n(?:(?: {2}.*)?\n)+/m)?.[0] ?? '';
    expect(block).toMatch(/^ {2}cancel-in-progress: \$\{\{ github\.event\.label\.name != 'bot-fold' \}\}$/m);
  });
});
