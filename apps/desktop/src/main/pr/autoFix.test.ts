import { describe, expect, it } from 'vitest';
import type { PrBinding, PrChangeRequest, PrReviewThread } from '@shared/pullRequest';
import { MAX_AUTO_FIX_ATTEMPTS, autoFixRefusal, autoFixToolRefusal, planAutoFix } from './autoFix';
import { REF, check, snapshot } from './prTestSupport';

const binding: PrBinding = {
  ...REF,
  source: 'shell',
  boundAt: '',
  autoFix: true,
  autoFixMax: MAX_AUTO_FIX_ATTEMPTS,
  lastState: 'OPEN',
};

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: 'thread-1',
    path: 'src/ladder.ts',
    line: 12,
    commentId: 901,
    author: 'reviewer',
    association: 'MEMBER',
    body: 'Please handle the empty ladder.',
    url: 'https://github.com/example-org/widgets/pull/611#discussion_r901',
    outdated: false,
    ...overrides,
  };
}

function changeRequest(overrides: Partial<PrChangeRequest> = {}): PrChangeRequest {
  return {
    reviewId: 77,
    author: 'reviewer',
    association: 'MEMBER',
    body: 'Verdict: request changes. The ladder breaks on an empty list.',
    url: 'https://github.com/example-org/widgets/pull/611#pullrequestreview-77',
    ...overrides,
  };
}

const failing = snapshot({ headSha: 'sha-bad', checks: [check('Build', 'fail'), check('Lint', 'pass')] });

describe('planAutoFix', () => {
  it('starts a turn for a settled failing run, keyed by the head commit', () => {
    const plan = planAutoFix(binding, failing, false);
    expect(plan.kind).toBe('start');
    if (plan.kind !== 'start') return;
    expect(plan.fingerprints).toEqual(['ci:sha-bad']);
    expect(plan.summary).toBe('1 failing check on #611');
    expect(plan.prompt).toContain(`Attempt 1 of ${MAX_AUTO_FIX_ATTEMPTS}`);
    expect(plan.prompt).toContain('Never force-push');
  });

  it('waits while any check is still running', () => {
    const running = snapshot({ checks: [check('Build', 'fail'), check('Test', 'pending')] });
    expect(planAutoFix(binding, running, false)).toEqual({ kind: 'none' });
  });

  it('does not act on the same failing run twice', () => {
    expect(planAutoFix({ ...binding, autoFixHandled: ['ci:sha-bad'] }, failing, false)).toEqual({ kind: 'none' });
  });

  it('acts again once a new commit fails', () => {
    const plan = planAutoFix(
      { ...binding, autoFixHandled: ['ci:sha-bad'] },
      { ...failing, headSha: 'sha-next' },
      false
    );
    expect(plan.kind === 'start' && plan.fingerprints).toEqual(['ci:sha-next']);
  });

  it('gives up after the attempt limit', () => {
    expect(planAutoFix({ ...binding, autoFixAttempts: MAX_AUTO_FIX_ATTEMPTS }, failing, false)).toEqual({
      kind: 'exhausted',
    });
  });

  it('gives a binding ticked for the new budget five attempts', () => {
    const last = planAutoFix({ ...binding, autoFixAttempts: 4 }, failing, false);
    expect(last.kind === 'start' && last.prompt).toContain('Attempt 5 of 5');
    expect(planAutoFix({ ...binding, autoFixAttempts: 5 }, failing, false)).toEqual({ kind: 'exhausted' });
  });

  it('keeps a binding ticked before the budget was stored at three attempts', () => {
    const { autoFixMax: _, ...legacy } = binding;
    expect(planAutoFix({ ...legacy, autoFixAttempts: 3 }, failing, false)).toEqual({ kind: 'exhausted' });
    const plan = planAutoFix({ ...legacy, autoFixAttempts: 2 }, failing, false);
    expect(plan.kind === 'start' && plan.prompt).toContain('Attempt 3 of 3');
  });

  it('waits for a running turn instead of starting one', () => {
    expect(planAutoFix(binding, failing, true)).toEqual({ kind: 'wait' });
  });

  it('does nothing when the box is off or the PR is no longer open', () => {
    expect(planAutoFix({ ...binding, autoFix: false }, failing, false)).toEqual({ kind: 'none' });
    expect(planAutoFix(binding, { ...failing, state: 'MERGED' }, false)).toEqual({ kind: 'none' });
  });

  it('acts on a new comment once, keyed by its id', () => {
    const withComment = snapshot({ threads: [thread()] });
    const plan = planAutoFix(binding, withComment, false);
    expect(plan.kind === 'start' && plan.fingerprints).toEqual(['comment:901']);
    expect(plan.kind === 'start' && plan.prompt).toContain('    > Please handle the empty ladder.');
    expect(planAutoFix({ ...binding, autoFixHandled: ['comment:901'] }, withComment, false)).toEqual({ kind: 'none' });
  });

  it('acts once on a review requesting changes with no inline comments', () => {
    const reviewed = snapshot({ reviewDecision: 'CHANGES_REQUESTED', changeRequests: [changeRequest()] });
    const plan = planAutoFix(binding, reviewed, false);
    expect(plan.kind).toBe('start');
    if (plan.kind !== 'start') return;
    expect(plan.fingerprints).toEqual(['review:77']);
    expect(plan.summary).toBe('1 change request on #611');
    expect(plan.prompt).toContain('    > Verdict: request changes.');
    expect(planAutoFix({ ...binding, autoFixHandled: ['review:77'] }, reviewed, false)).toEqual({ kind: 'none' });
  });

  it.each([
    ['by someone without write access', changeRequest({ author: 'drive-by', association: 'NONE' })],
    ['by the viewer', changeRequest({ author: 'octo-dev', association: 'OWNER' })],
    ['with no body', changeRequest({ body: ' ' })],
  ])('ignores a change request %s', (_label, ignored) => {
    expect(planAutoFix(binding, snapshot({ changeRequests: [ignored] }), false)).toEqual({ kind: 'none' });
  });

  it.each([
    ['an outdated comment', thread({ outdated: true })],
    ['a comment by the viewer', thread({ author: 'octo-dev', association: 'OWNER' })],
    ['a comment by someone without write access', thread({ author: 'drive-by', association: 'NONE' })],
    ['an empty comment', thread({ body: '   ' })],
  ])('ignores %s', (_label, ignored) => {
    expect(planAutoFix(binding, snapshot({ threads: [ignored] }), false)).toEqual({ kind: 'none' });
  });

  it("acts on the PR author's own comments even without write access", () => {
    const authored = snapshot({
      viewer: 'someone-else',
      threads: [thread({ author: 'octo-dev', association: 'NONE' })],
    });
    expect(planAutoFix(binding, authored, false).kind).toBe('start');
  });
});

describe('planAutoFix on merge conflicts', () => {
  const conflicting = snapshot({ headSha: 'sha-head', baseSha: 'sha-base', mergeable: 'CONFLICTING' });

  it('starts a turn for a conflicting PR, keyed by head and base', () => {
    const plan = planAutoFix(binding, conflicting, false);
    expect(plan.kind).toBe('start');
    if (plan.kind !== 'start') return;
    expect(plan.fingerprints).toEqual(['conflict:sha-head:sha-base']);
    expect(plan.summary).toBe('merge conflicts on #611');
    expect(plan.prompt).toContain('git fetch origin main');
    expect(plan.prompt).toContain('MERGE `origin/main`');
    expect(plan.prompt).toContain('Do not rebase.');
    expect(plan.prompt).toContain('never `git add -A`');
    expect(plan.prompt).toContain('do not guess');
    expect(plan.prompt).toContain('Never force-push');
  });

  it('does not act while GitHub is still computing mergeability', () => {
    expect(planAutoFix(binding, { ...conflicting, mergeable: 'UNKNOWN' }, false)).toEqual({ kind: 'none' });
  });

  it('does not act twice on the same head and base', () => {
    const handled = { ...binding, autoFixHandled: ['conflict:sha-head:sha-base'] };
    expect(planAutoFix(handled, conflicting, false)).toEqual({ kind: 'none' });
  });

  it('acts again once the base branch moves', () => {
    const handled = { ...binding, autoFixHandled: ['conflict:sha-head:sha-base'] };
    const plan = planAutoFix(handled, { ...conflicting, baseSha: 'sha-base-2' }, false);
    expect(plan.kind === 'start' && plan.fingerprints).toEqual(['conflict:sha-head:sha-base-2']);
  });

  it('puts the conflict first when comments and failing checks come with it', () => {
    const plan = planAutoFix(binding, { ...conflicting, checks: [check('Build', 'fail')], threads: [thread()] }, false);
    expect(plan.kind).toBe('start');
    if (plan.kind !== 'start') return;
    expect(plan.fingerprints).toEqual(['conflict:sha-head:sha-base', 'ci:sha-head', 'comment:901']);
    expect(plan.summary).toBe('merge conflicts and 1 failing check and 1 new review comment on #611');
    const conflictAt = plan.prompt.indexOf('merge conflicts with its base branch');
    expect(conflictAt).toBeGreaterThan(-1);
    expect(conflictAt).toBeLessThan(plan.prompt.indexOf('These checks failed'));
    expect(conflictAt).toBeLessThan(plan.prompt.indexOf('New review comments'));
  });

  it('counts against the attempt limit', () => {
    expect(planAutoFix({ ...binding, autoFixAttempts: MAX_AUTO_FIX_ATTEMPTS }, conflicting, false)).toEqual({
      kind: 'exhausted',
    });
  });

  it('waits for a running turn', () => {
    expect(planAutoFix(binding, conflicting, true)).toEqual({ kind: 'wait' });
  });
});

describe('autoFixRefusal', () => {
  it.each([
    'git push --force',
    'git push -f origin feat/widget-ladder',
    'git push --force-with-lease',
    'git push origin +feat/widget-ladder',
    'git add . && git push --force',
    'gh pr merge 611 --squash',
    'gh api repos/example-org/widgets/pulls/611/merge -X PUT',
  ])('refuses %s', command => {
    expect(autoFixRefusal(command)).not.toBeNull();
  });

  it.each(['git push', 'git push -u origin feat/widget-ladder', 'git commit -m "fix" && git push', 'gh pr checks 611'])(
    'allows %s',
    command => {
      expect(autoFixRefusal(command)).toBeNull();
    }
  );
});

describe('autoFixToolRefusal', () => {
  it('refuses handing the work to another conversation', () => {
    expect(autoFixToolRefusal('session_spawn', { prompt: 'git push --force' })).not.toBeNull();
    expect(autoFixToolRefusal('session_send', { text: 'merge it' })).not.toBeNull();
  });

  it('checks shell commands and leaves other tools alone', () => {
    expect(autoFixToolRefusal('bash_execute', { command: 'git push -f' })).not.toBeNull();
    expect(autoFixToolRefusal('bash_execute', { command: 'git push' })).toBeNull();
    expect(autoFixToolRefusal('file_write', { path: 'a.ts' })).toBeNull();
  });
});
