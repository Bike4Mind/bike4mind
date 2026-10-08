import { describe, expect, it } from 'vitest';
import type { PrBinding, PrReviewThread } from '@shared/pullRequest';
import { MAX_AUTO_FIX_ATTEMPTS, autoFixRefusal, planAutoFix } from './autoFix';
import { REF, check, snapshot } from './prTestSupport';

const binding: PrBinding = { ...REF, source: 'shell', boundAt: '', autoFix: true, lastState: 'OPEN' };

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

const failing = snapshot({ headSha: 'sha-bad', checks: [check('Build', 'fail'), check('Lint', 'pass')] });

describe('planAutoFix', () => {
  it('starts a turn for a settled failing run, keyed by the head commit', () => {
    const plan = planAutoFix(binding, failing, false);
    expect(plan.kind).toBe('start');
    if (plan.kind !== 'start') return;
    expect(plan.fingerprints).toEqual(['ci:sha-bad']);
    expect(plan.summary).toBe('1 failing check on #611');
    expect(plan.prompt).toContain('Attempt 1 of 3');
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
