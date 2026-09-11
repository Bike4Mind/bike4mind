import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
 * Where a control is an executable shell fragment it is EXTRACTED FROM THE COMMITTED YAML AND
 * RUN, not pattern-matched. An earlier version of this file asserted only that the guard's text
 * was present, which left `grep -v -E`, a dropped `--cached` and an appended `CHANGED=0` all
 * passing - each of which disarms the guard completely while every literal it named survived.
 * Text matching is still used for the declarative parts (tool lists, `if:` gates, step `env:`),
 * matching the sibling guards: the repo carries no YAML parser dependency and adding one for a
 * workflow assertion is not worth the supply chain.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'pr-bot-review.yml');

/**
 * One `- name: X` step, from its name line up to the next list item at the same indent - or to
 * the end of the file, since the last step in the job has no following step to stop at. The name
 * must match in full (a trailing parenthetical aside is allowed) and must resolve to exactly one
 * step, so a new step whose name merely starts with an asserted one cannot silently be picked up
 * instead. The terminator is any `- ` at step indent, not `- name: ` alone, so a step written in
 * some other YAML order cannot let one block bleed into the next.
 */
function step(src: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^ {6}- name: ${escaped}(?: \\(.*\\))?$`, 'gm');
  expect([...src.matchAll(head)], `step name is not unique: ${name}`).toHaveLength(1);
  const found = src.match(
    new RegExp(`^ {6}- name: ${escaped}(?: \\(.*\\))?$[\\s\\S]*?(?=^ {6}- |$(?![\\s\\S]))`, 'm')
  )?.[0];
  expect(found, `step not found: ${name}`).toBeTruthy();
  return found ?? '';
}

/**
 * The given YAML text with whole-line comments dropped, so prose cannot satisfy an assertion.
 * Applied to a whole step this keeps the `name:`, `if:`, `env:` and `run:` lines and any inline
 * trailing comment - it is a comment filter, not a `run:` extractor.
 */
function withoutComments(yaml: string): string {
  return yaml
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

/** Every `run:` body in the file, both the block-scalar and the single-line form, uncommented. */
function runBodies(src: string): string[] {
  return [
    ...[...src.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)].map(m => m[1]),
    ...[...src.matchAll(/^ {8}run: (?!\|)(.*)$/gm)].map(m => m[1]),
  ].map(withoutComments);
}

/** The value of a `--allowedTools` / `--disallowedTools` flag, unquoted, in file order. */
function toolFlagValues(src: string, flag: string): string[] {
  return [...src.matchAll(new RegExp(`^\\s*--${flag} "(.*)"\\s*$`, 'gm'))].map(m => m[1]);
}

/**
 * Splits one tool-flag value on its `${{ cond && 'a' || 'b' }}` mode ternary. The arms are
 * identified by POLARITY, never by length: labelling them by which list is longer is what let an
 * inverted condition read as correct. Text outside the ternary belongs to both arms. The
 * condition is returned so it can be asserted too.
 */
function toolListModes(value: string): { condition: string; fold: string[]; review: string[] } {
  // The condition may hold no braces, so a plain `${{ runner.temp }}` elsewhere in the value
  // cannot be mistaken for the start of the ternary.
  const ternary = value.match(/\$\{\{([^{}]*?)&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}/);
  // Thrown rather than expect()ed: a missing ternary means the mode split itself is gone, and
  // every assertion downstream of here would be meaningless rather than merely failing.
  if (!ternary) throw new Error(`no mode ternary in tool list: ${value}`);
  const [whole, condition, trueArm, falseArm] = ternary;
  const literal = value.replace(whole, '');
  const names = (branch: string) =>
    (literal + branch)
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
  return { condition, fold: names(trueArm), review: names(falseArm) };
}

/**
 * The conjuncts of a step's block-scalar `if:`, in order. Compared as a set by value rather than
 * by substring presence: `steps.x.outcome == 'success' || true` still CONTAINS the text of the
 * gate it disarms, so `toMatch` cannot tell a live gate from a neutralised one.
 */
function ifConjuncts(src: string, name: string): string[] {
  const block = step(src, name).match(/^ {8}if: \|\n((?: {10}.*\n)+)/m)?.[1];
  expect(block, `${name}: no block-scalar if:`).toBeTruthy();
  return (block ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split('&&')
    .map(conjunct => conjunct.trim())
    .filter(Boolean);
}

type StagedFile = { path: string; lines?: number; binary?: boolean };

/**
 * Runs the push step's staged-path guard and diff-size bound, lifted verbatim out of the
 * committed YAML, against a scratch repo with `files` staged. Returns the exit status and
 * combined output, so a test can assert what the guard actually blocks instead of asserting that
 * its patterns are spelled correctly.
 *
 * The region runs under the same `set -euo pipefail` the step uses, with `emit` and
 * `$GITHUB_OUTPUT` stubbed - those are the only two things it needs from the surrounding step.
 */
function runStagedGuards(src: string, files: StagedFile[]): { status: number; out: string } {
  const commands = withoutComments(step(src, 'Push fold commit'));
  const region = commands.match(/^ {10}BLOCKED=\$\([\s\S]*?-gt 800 \]; then\n[\s\S]*?^ {10}fi$/m)?.[0];
  expect(region, 'could not lift the staged-path guard and size bound out of the push step').toBeTruthy();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-fold-guard-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q', '.');
    for (const file of files) {
      const abs = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.binary ? Buffer.from([0x1f, 0x8b, 0x00, 0x41]) : 'x\n'.repeat(file.lines ?? 1));
      git('add', '--', file.path);
    }
    const script = [
      'set -euo pipefail',
      'emit() { echo "emit:$1"; }',
      `GITHUB_OUTPUT=${JSON.stringify(path.join(dir, 'outputs'))}`,
      region ?? '',
      'echo GUARDS_PASSED',
    ].join('\n');
    const run = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' });
    return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    // The fold mode adds exactly the two local file-write tools and no API writer.
    // `MultiEdit` is deliberately NOT here: this CLI version does not know that name
    // and warns that the rule matches no known tool, so granting it granted nothing.
    expect(allow.fold.filter(tool => !allow.review.includes(tool)).sort()).toEqual(['Edit', 'Write']);
  });

  it('grants the file-write tools on the fold mode only', () => {
    // Deny beats allow, so the deny list is the side that actually decides this.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    for (const tool of ['Write', 'Edit']) {
      expect(deny.review).toContain(tool);
      expect(deny.fold).not.toContain(tool);
    }
    // The two modes differ by those two names and nothing else.
    expect(deny.review.filter(tool => !deny.fold.includes(tool)).sort()).toEqual(['Edit', 'Write']);
  });

  it('fences the fold write tools by Edit() spec, the only spelling the CLI honours', () => {
    // Spelling first, because getting it wrong is silent. `Write(path)` and
    // `MultiEdit(path)` specs are IGNORED by the file-permission checks - the CLI says
    // so on stderr and exits 0 - while an `Edit(path)` rule covers every file-editing
    // tool. A previous revision carried all three spellings for both roots, which read
    // as six controls and was two, and is how the $RUNNER_TEMP hole below got missed.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    const pathSpecs = deny.fold.filter(spec => spec.includes('('));
    expect(pathSpecs.filter(spec => /^(Write|MultiEdit)\(/.test(spec))).toEqual([]);

    // The fold write fence, by value. Repo-relative roots plus the runner temp root,
    // because a bare write-tool grant reaches absolute paths anywhere on the filesystem
    // and not only the working directory. $RUNNER_TEMP holds the runner's own
    // `_runner_file_commands` files ($GITHUB_PATH / $GITHUB_ENV, i.e. command execution
    // in every later step), the private bot-review skill, and the action's transcript.
    expect(pathSpecs.filter(spec => spec.startsWith('Edit(')).sort()).toEqual(
      ['Edit(.git/**)', 'Edit(.github/**)', 'Edit(/${{ runner.temp }}/**)'].sort()
    );
    // Read fences asserted on BOTH arms. The step's own comment says both branches are
    // spelled out in full by design, so every edit here is a both-arms edit, and a
    // fold-arm-only assertion waves the review arm through.
    for (const spec of ['Read(.git/**)', 'Read(//proc/**)', 'Read(//sys/**)']) {
      expect(deny.fold).toContain(spec);
      expect(deny.review).toContain(spec);
    }
    // Single-shot process, so a wakeup can only ever be a lost run. Denied in both arms.
    expect(deny.fold).toContain('ScheduleWakeup');
    expect(deny.review).toContain('ScheduleWakeup');
    // And nothing may widen the permission model out from under the deny list.
    const reviewStep = step(src, 'Run /bot-review');
    expect(reviewStep).not.toMatch(/--permission-mode|--dangerously-skip-permissions|--settings/);
  });

  it('never runs repo-tracked code out of the checkout', () => {
    // The fence above bounds what the agent may edit; this bounds what the job may
    // execute, which is the half that does not depend on the permission system holding.
    // A tracked file run from the tree is code execution in THIS run, and the push
    // step's path guard cannot reach it: the guard only gates what gets COMMITTED, and
    // on a run that posts no review it does not run at all.
    // Matches an interpreter followed by any path-shaped argument, over both `run:`
    // forms - a single-line `run: bash ./install-hooks.sh` is invisible to a
    // block-scalar-only sweep, which is how the previous version of this assertion
    // (a check for the string GITHUB_WORKSPACE, which appears nowhere in the file)
    // managed to pass while constraining nothing.
    const interpretedPath =
      /(?:^|[\s|;&(])(?:bash|sh|zsh|source|python3?|node|npx|pnpm|yarn|ruby|perl)\s+(?:-\S+\s+)*(?:\.?\/|[A-Za-z0-9_.@-]+\/|\$\{?GITHUB_WORKSPACE)/;
    for (const body of runBodies(src)) {
      expect(body).not.toMatch(interpretedPath);
    }
    // Composite actions in this repo are tracked files too, and `uses:` is not a `run:`.
    expect(src).not.toMatch(/uses: \.\//);
  });

  it('feeds the transcript redactor from the object store at the point of use', () => {
    // `Redact and upload review transcript` EXECUTES the redactor, on the
    // `posted != 'true'` branch - exactly where the push step's path guard never runs.
    // So the bytes are read out of the commit and piped straight into the interpreter:
    // there is no file on disk for anything to have pre-written, in the checkout or in
    // $RUNNER_TEMP. Staging a copy to a file BEFORE the agent ran was the previous
    // shape, and it moved the executed file out of the repo and out of the write fence.
    const transcript = withoutComments(step(src, 'Redact and upload review transcript'));
    expect(transcript).toMatch(
      /git show HEAD:\.github\/scripts\/redact-review-transcript\.py \|\n\s*python3 - "\$EXECUTION_FILE" "\$SKILL_FILE" "\$DEST"/
    );
    // Every python3 the job runs reads its program from stdin. A path argument would be a
    // file, and a file is something that can be written before this step runs.
    expect(
      runBodies(src)
        .join('\n')
        .match(/python3 \S+/g)
    ).toEqual(['python3 -']);
    // The redactor derives the strings it strips by READING the skill file, so that file
    // is the redaction list, and it lives in the unfenced-by-default $RUNNER_TEMP. It is
    // checked against a hash taken before the agent ran; without this the private skill
    // passes through the transcript in the clear and gets published as a world-readable
    // artifact on a public repo, with no code execution needed.
    expect(withoutComments(step(src, 'Fetch bot-review skill from b4m-devtools'))).toMatch(
      /echo "skill_sha=\$\(sha256sum "\$DEST" \| cut -d' ' -f1\)" >> "\$GITHUB_OUTPUT"/
    );
    expect(transcript).toMatch(/^ {10}SKILL_SHA: \$\{\{ steps\.skill_fetch\.outputs\.skill_sha \}\}$/m);
    const hashGate = transcript.match(
      /^ {10}if \[ -z "\$SKILL_SHA" \] \|\| \[ "\$\(sha256sum "\$SKILL_FILE" \| cut -d' ' -f1\)" != "\$SKILL_SHA" \]; then\n[\s\S]*?^ {10}fi$/m
    )?.[0];
    expect(hashGate, 'the transcript step does not check the skill file against its fetch hash').toBeTruthy();
    // Fail CLOSED: no upload, rather than an upload redacted against the wrong list.
    expect(hashGate).toMatch(/^ {12}echo "uploadable=false" >> "\$GITHUB_OUTPUT"$/m);
    expect(hashGate).toMatch(/^ {12}exit 0$/m);
    // And it has to run before the redactor, not after it.
    expect(transcript.indexOf('-z "$SKILL_SHA"')).toBeLessThan(transcript.indexOf('git show HEAD:'));
  });

  it('runs git after the agent with no config the agent could have planted', () => {
    // $HOME is neither the checkout nor $RUNNER_TEMP, so no write fence covers it, and a
    // global git config is command execution: `filter.<x>.clean` runs through a shell
    // during `git add -u`, driven by a working-tree `.gitattributes` that need not be
    // tracked and so never reaches the path guard. `git add` still exits 0, so
    // `set -euo pipefail` does not catch it - and this is all UPSTREAM of the path guard,
    // the size bound and --no-verify. The same file also reaches `http.proxy` and
    // `url.<base>.insteadOf`, either of which hands the push token to a chosen host.
    for (const name of ['Push fold commit', 'Redact and upload review transcript']) {
      const stepSrc = step(src, name);
      expect(stepSrc, `${name}: no GIT_CONFIG_GLOBAL`).toMatch(/^ {10}GIT_CONFIG_GLOBAL: \/dev\/null$/m);
      expect(stepSrc, `${name}: no GIT_CONFIG_SYSTEM`).toMatch(/^ {10}GIT_CONFIG_SYSTEM: \/dev\/null$/m);
      expect(stepSrc, `${name}: no GIT_CONFIG_NOSYSTEM`).toMatch(/^ {10}GIT_CONFIG_NOSYSTEM: '1'$/m);
    }
    // With the global config nulled, `git config user.email` would write to /dev/null and
    // the commit would come out unattributed - which cla.yml and main-protection both key
    // off. Identity has to be passed per-invocation instead.
    const commands = withoutComments(step(src, 'Push fold commit'));
    expect(commands).not.toMatch(/git config/);
    expect(commands).toMatch(
      /git -c user\.name='claude\[bot\]' \\\n\s*-c user\.email='claude\[bot\]@users\.noreply\.github\.com' \\\n\s*commit /
    );
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

  it('mints, pushes and reports on exactly the conditions it claims to', () => {
    // Asserted as a conjunct SET, by value. Substring assertions cannot see the difference
    // between a live gate and `... || true` appended to it, which neutralises the gate while
    // leaving every literal in place - and `always()` is true on cancellation, so it would
    // leave the mint and the push eligible on a run the user stopped.
    expect(ifConjuncts(src, 'Mint fold push token')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.bot_review.outcome == 'success'",
      "steps.review_posted.outputs.posted == 'true'",
    ]);
    expect(ifConjuncts(src, 'Push fold commit')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.push_token.outcome == 'success'",
    ]);
    // `Report fold failure` keys on the SAME measurement as the mint, which is what keeps it
    // from double-commenting with `Report incomplete review` (gated on the complement). And on
    // `!= 'success'` rather than `== 'failure'`, so a review that lands and then errors -
    // which skips the mint, the push and the no-op reporter in one go - still gets an
    // explanation instead of a bare red check.
    expect(ifConjuncts(src, 'Report fold failure')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.review_posted.outputs.posted == 'true'",
      "(steps.push_token.outcome != 'success' || steps.fold_push.outcome != 'success')",
    ]);
    expect(ifConjuncts(src, 'Report fold no-op')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.fold_push.outcome == 'success'",
      "(steps.fold_push.outputs.pushed == 'none' || steps.fold_push.outputs.dropped != '')",
    ]);
  });

  it('commits only tracked-file edits, and fails rather than falling through', () => {
    const commands = withoutComments(step(src, 'Push fold commit'));
    // Tracked files only, and pinned as the WHOLE set of `git add` invocations: with Write
    // in hand the agent can drop a NEW file into the tree, and an appended `git add -- .`
    // or `git add packages b4m-core apps` would commit it while leaving `git add -u` in
    // place for a pattern check to find.
    expect(commands.match(/git add[^\n]*/g)).toEqual(['git add -u']);
    // The step must fail rather than fall through: without `-e` a failed `git commit`
    // reaches `git push`, which says "Everything up-to-date" and exits 0, so the step
    // emits pushed=true under a green check with nothing on the branch.
    expect(commands).toMatch(/^ {10}set -euo pipefail$/m);
    // And both bounds run before the commit, not after it.
    expect(commands.indexOf('BLOCKED=')).toBeLessThan(commands.indexOf('git -c user.name'));
    expect(commands.indexOf('CHANGED=')).toBeLessThan(commands.indexOf('git -c user.name'));
  });

  it('refuses the whole fixup when a staged path is CI configuration', () => {
    // Behaviour, not text. The guard is lifted out of the committed YAML and run against a
    // scratch index: `grep -v -E`, a dropped `--cached` and an `^zzz(...)`-prefixed anchor
    // each disarm it completely while leaving every literal it names in place.
    const blocked = [
      '.github/workflows/pr-bot-review.yml',
      '.husky/pre-commit',
      '.claude/settings.json',
      'scripts/check-no-control-bytes.sh',
      'infra/subscriberFanout.ts',
      'patches/some-dep.patch',
      'package.json',
      'packages/scripts/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'turbo.json',
      '.npmrc',
      'Dockerfile',
      'apps/client/tools/helper.sh',
      'dev',
      'sst-dev-fast',
    ];
    const allowed = [
      'apps/client/app/components/Foo.tsx',
      'b4m-core/common/src/api-contract/chat.contract.ts',
      'packages/scripts/src/checkBotFoldWritePath.test.ts',
      'packages/database/src/models/user.ts',
      'README.md',
      'docs/architecture.md',
    ];

    // Refuses on the whole set, and names every blocked path rather than the first.
    const all = runStagedGuards(
      src,
      [...blocked, ...allowed].map(p => ({ path: p }))
    );
    expect(all.status).toBe(1);
    expect(all.out).not.toContain('GUARDS_PASSED');
    expect(all.out).toContain('emit:blocked');
    for (const p of blocked) expect(all.out).toContain(p);
    for (const p of allowed) expect(all.out).not.toContain(p);

    // Each blocked path on its own, so one decayed pattern cannot hide behind the others.
    for (const p of blocked) {
      expect(runStagedGuards(src, [{ path: p }]).status, `not blocked: ${p}`).toBe(1);
    }
    // And ordinary source passes, or the guard is a fold that never applies anything.
    const clean = runStagedGuards(
      src,
      allowed.map(p => ({ path: p }))
    );
    expect(clean.status, clean.out).toBe(0);
    expect(clean.out).toContain('GUARDS_PASSED');
  });

  it('refuses a staged binary and a non-ASCII CI path', () => {
    // numstat reports `-` changed lines for a binary however large the rewrite, so the size
    // bound scores it 0; it is the path guard's job.
    const binary = runStagedGuards(src, [{ path: 'apps/client/public/logo.png', binary: true }]);
    expect(binary.status).toBe(1);
    expect(binary.out).toContain('apps/client/public/logo.png');
    // Under git's default core.quotePath, a path holding a non-ASCII byte comes out quoted
    // and backslash-escaped: the leading quote defeats the `^(...)/` anchor and the trailing
    // one defeats `\.(sh|bash|zsh)$`, so the guard matches nothing at all for such a file.
    // Written as an escape to keep this file ASCII per CLAUDE.md.
    const nonAscii = runStagedGuards(src, [{ path: '.github/workflows/caf\u00e9.yml' }]);
    expect(nonAscii.status, nonAscii.out).toBe(1);
  });

  it('refuses a fixup past the diff-size bound', () => {
    // Same principle as the path guard, on volume: a fold applies review findings, so a
    // sprawling diff means something other than that happened. Run rather than matched -
    // appending `CHANGED=0` after the assignment leaves the whole bound spelled out and
    // makes it unreachable.
    const under = runStagedGuards(src, [{ path: 'apps/client/app/a.ts', lines: 800 }]);
    expect(under.status, under.out).toBe(0);
    expect(under.out).toContain('fold: 800 changed lines staged');

    const over = runStagedGuards(src, [{ path: 'apps/client/app/a.ts', lines: 801 }]);
    expect(over.status).toBe(1);
    expect(over.out).toContain('past the 800-line bound');
    expect(over.out).toContain('emit:blocked');
    expect(over.out).not.toContain('GUARDS_PASSED');
  });

  it('pushes non-force to the PR head ref, with a token the checkout never held', () => {
    // Scoped to the commands, not the step text: the step's own comments quote `git push origin`
    // while explaining why we do not use it, and that comment contains the word `--force` too.
    const commands = withoutComments(step(src, 'Push fold commit'));
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
