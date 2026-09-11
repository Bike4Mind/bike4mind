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

  it('grants only read-shaped GitHub tools plus the review-submission ones', () => {
    // Pinned BY VALUE, not by spot-checks. The list already holds five write-shaped
    // `mcp__github__*` names (the pending-review lifecycle), so one more - say
    // `create_or_update_file` - reads as routine and would let the agent write to the
    // branch through claude-code-action's OWN App token, routing around `git add -u`,
    // the path guard, the size bound, the non-force flag and the refspec at once.
    // Nothing else in this repo can catch that, so the whole set is spelled out here
    // and adding to it has to be a deliberate edit in two places.
    const allow = toolListModes(toolFlagValues(src, 'allowedTools')[0]);
    expect(allow.review.sort()).toEqual(
      [
        'Agent',
        'Glob',
        'Grep',
        'Read',
        'Task',
        'mcp__github__add_comment_to_pending_review',
        'mcp__github__create_and_submit_pull_request_review',
        'mcp__github__create_pending_pull_request_review',
        'mcp__github__delete_pending_pull_request_review',
        'mcp__github__get_commit',
        'mcp__github__get_file_contents',
        'mcp__github__get_issue',
        'mcp__github__get_issue_comments',
        'mcp__github__get_pull_request',
        'mcp__github__get_pull_request_diff',
        'mcp__github__get_pull_request_files',
        'mcp__github__get_pull_request_review_comments',
        'mcp__github__get_pull_request_reviews',
        'mcp__github__get_pull_request_status',
        'mcp__github__list_commits',
        'mcp__github__submit_pending_pull_request_review',
      ].sort()
    );
    // The fold mode adds exactly the three local file-write tools and no API writer.
    expect(allow.fold.filter(tool => !allow.review.includes(tool)).sort()).toEqual(['Edit', 'MultiEdit', 'Write']);
  });

  it('grants the file-write tools on the fold mode only', () => {
    // Deny beats allow, so the deny list is the side that actually decides this.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(deny.review).toContain(tool);
      expect(deny.fold).not.toContain(tool);
    }
    // The two modes differ by those three names and nothing else.
    expect(deny.review.filter(tool => !deny.fold.includes(tool)).sort()).toEqual(['Edit', 'MultiEdit', 'Write']);
  });

  it('fences the fold write tools out of .github/ and .git/', () => {
    // The path guard in the push step gates what gets COMMITTED. It does not gate what
    // the agent may edit in a tree this same job then runs code from - and on the runs
    // that do run that code the guard never executes at all, because the transcript
    // step is gated on `posted != 'true'` while the guard needs `posted == 'true'`.
    // So the write tools are fenced here as well:
    //   .github/** - `Redact and upload review transcript` runs a tracked script, and
    //     the later `gh` steps hold GITHUB_TOKEN with pull-requests and issues write,
    //     so $GITHUB_PATH/$GITHUB_ENV are reachable from anything that runs.
    //   .git/** - `git add -u` in the push step would run a `filter.*.clean` command
    //     out of .git/info/attributes, in the step holding the push token. Denying
    //     Read(.git/**) blocks writes there today too, but that is harness behaviour,
    //     not a contract, so it is stated rather than relied on.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    for (const root of ['.github/**', '.git/**']) {
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        expect(deny.fold).toContain(`${tool}(${root})`);
      }
    }
    // Read fences asserted on BOTH arms. The step's own comment says both branches are
    // spelled out in full by design, so every edit here is a both-arms edit, and a
    // fold-arm-only assertion waves the review arm through.
    for (const spec of ['Read(.git/**)', 'Read(//proc/**)', 'Read(//sys/**)']) {
      expect(deny.fold).toContain(spec);
      expect(deny.review).toContain(spec);
    }
  });

  it('runs the transcript redactor from a copy taken before the agent ran', () => {
    // Second half of the .github/** fence, and the half that does not depend on the
    // permission system: the executed copy is read out of the commit with `git show`
    // in a step that precedes the review, so editing the tracked file changes nothing
    // that runs. Both halves are asserted because either alone closes the hole and
    // neither is obvious from the other's absence.
    const stageStep = 'Stage the transcript redactor out of the working tree';
    const staging = runCommands(step(src, stageStep));
    expect(staging).toMatch(/git show HEAD:\.github\/scripts\/redact-review-transcript\.py > "\$REDACTOR"/);
    // Before the review step, not after it.
    expect(src.indexOf(`- name: ${stageStep}`)).toBeLessThan(src.indexOf('- name: Run /bot-review'));
    // And the transcript step executes that copy and never the path in the checkout.
    const transcript = runCommands(step(src, 'Redact and upload review transcript'));
    expect(transcript).toMatch(/python3 "\$REDACTOR"/);
    // Scoped to the checkout path: the step's own `env:` names the $RUNNER_TEMP copy,
    // which is the whole point, so a bare filename check would match that instead.
    expect(transcript).not.toMatch(/\.github\/scripts\//);
    // Both steps have to name the same file for the staging to mean anything.
    const dest = /^\s*REDACTOR: \$\{\{ runner\.temp \}\}\/redact-review-transcript\.py$/gm;
    expect(src.match(dest)).toHaveLength(2);
    // Nothing else in the job may run repo-tracked code from the checkout, or the
    // fence above is the only thing standing between an edit and execution.
    const runBodies = [...src.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)].map(m => runCommands(m[1])).join('\n');
    expect(runBodies).not.toMatch(/GITHUB_WORKSPACE/);
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
    expect(step(src, 'Mint fold push token')).toMatch(/steps\.review_posted\.outputs\.posted == 'true'/);
    // `Report fold failure` keys on the SAME measurement, which is what keeps it from
    // double-commenting with `Report incomplete review` (gated on the complement).
    // And on `!= 'success'` rather than `== 'failure'`, so a review that lands and
    // then errors - which skips the mint, the push and the no-op reporter in one go -
    // still gets an explanation instead of a bare red check.
    const failureGate = step(src, 'Report fold failure');
    expect(failureGate).toMatch(/steps\.review_posted\.outputs\.posted == 'true'/);
    expect(failureGate).toMatch(/steps\.push_token\.outcome != 'success'/);
    expect(failureGate).toMatch(/steps\.fold_push\.outcome != 'success'/);
  });

  it('refuses to commit a file CI executes', () => {
    // The push carries an App token on purpose, so it DOES trigger workflows - which run tracked
    // scripts in steps holding write tokens. `git add -u` bounds the commit to tracked files; this
    // guard is the only thing bounding it by path, and without it injected text in a public PR
    // comment becomes code execution on the next `synchronize`.
    const commands = runCommands(step(src, 'Push fold commit'));
    // Tracked files only, and asserted rather than left to the comment: with Write in
    // hand the agent can drop a NEW file into the tree, and `git add -A` would commit
    // it. `-u` is cited as a control by both this test and the workflow.
    expect(commands).toMatch(/^ {10}git add -u$/m);
    expect(commands).not.toMatch(/git add (-A|--all|\.)/);
    // The step must fail rather than fall through: without `-e` a failed `git commit`
    // reaches `git push`, which says "Everything up-to-date" and exits 0, so the step
    // emits pushed=true under a green check with nothing on the branch.
    expect(commands).toMatch(/^ {10}set -euo pipefail$/m);

    const guard = commands.match(/BLOCKED=\$\([\s\S]*?^ {10}\)$/m)?.[0];
    expect(guard, 'no staged-path guard in the push step').toBeTruthy();
    // The whole denied set, not a spot-check: each of these is a distinct route from a
    // pushed file to code running in a later job with a write token or a repo secret,
    // and the prompt promises the agent the same list.
    for (const pattern of [
      '.github',
      '.husky',
      '.claude',
      'scripts',
      'infra',
      'patches',
      'package\\.json',
      'pnpm-lock\\.yaml',
      'package-lock\\.json',
      'yarn\\.lock',
      'pnpm-workspace\\.yaml',
      'turbo\\.json',
      '\\.npmrc',
      'Dockerfile',
      'sh|bash|zsh',
      'sst-dev-fast',
    ]) {
      expect(guard).toContain(pattern);
    }
    // A binary is `-` in numstat, so it scores 0 against the size bound however large
    // the rewrite; it is refused by the path guard instead.
    expect(guard).toMatch(/awk '\$1 == "-" \{ print \$3 \}'/);
    // Refuse the whole fixup rather than committing the acceptable subset. Scoped to the `if`
    // block's own `fi`, so a stray `exit 1` from a later block cannot stand in for this one.
    const refusal = commands.match(/^ {10}if \[ -n "\$BLOCKED" \]; then\n[\s\S]*?^ {10}fi$/m)?.[0];
    expect(refusal, 'the blocked-path branch does not refuse').toBeTruthy();
    expect(refusal).toMatch(/^ {12}exit 1$/m);
    // And it has to run before the commit, not after it.
    expect(commands.indexOf('BLOCKED=')).toBeLessThan(commands.indexOf('git commit'));

    // Same principle, on volume rather than path: a fold applies review findings, so a sprawling
    // diff means something else happened. Asserted so the bound cannot decay into a log line.
    const sizeBound = commands.match(/^ {10}if \[ "\$CHANGED" -gt 800 \]; then\n[\s\S]*?^ {10}fi$/m)?.[0];
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
    // One ref, and it is the one the PR came from. The literal alone is not enough:
    // rebinding HEAD_REF in the step env to `base.ref` (or to `github.ref_name`) leaves
    // this text untouched and pushes the fold commit to the PR's BASE branch - i.e. to
    // main. So the binding is pinned too, in the step that holds the token.
    expect(commands.match(/refs\/heads\/\S+/g)).toEqual(['refs/heads/${HEAD_REF}"']);
    const pushStep = step(src, 'Push fold commit');
    expect(pushStep).toMatch(/^ {10}HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}$/m);
    expect(pushStep).toMatch(/^ {10}PUSH_TOKEN: \$\{\{ steps\.push_token\.outputs\.token \}\}$/m);
    // The push host is pinned with it: an explicit URL is what keeps the narrowly
    // scoped token in use instead of the wider one claude-code-action left on origin.
    expect(commands).toContain('https://x-access-token:${PUSH_TOKEN}@github.com/${REPO}.git');
    expect(commands).not.toMatch(/git push \S*origin/);

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
