import { describe, expect, it } from 'vitest';
import { check, REF, snapshot } from '../pr/prTestSupport';
import type { GhRunner } from '../pr/gh';
import { loopRunnerToolRefusal, mergeDecision, repoSlug, runDeployCheck, runSmoke } from './guards';

const green = (overrides = {}) =>
  snapshot({
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    checks: [check('Build', 'pass')],
    ...overrides,
  });

describe('loopRunnerToolRefusal', () => {
  it('refuses a shell merge or force-push, and allows session_spawn', () => {
    expect(loopRunnerToolRefusal('bash_execute', { command: 'git add . && gh pr merge 3 --squash' })).toMatch(
      /loop_merge_pr/
    );
    expect(loopRunnerToolRefusal('bash_background', { command: 'git push --force origin x' })).toMatch(/force-push/);
    expect(loopRunnerToolRefusal('bash_execute', { command: 'git push origin x' })).toBeNull();
    expect(loopRunnerToolRefusal('session_spawn', { prompt: 'go' })).toBeNull();
    expect(loopRunnerToolRefusal('set_session_pull_request', {})).not.toBeNull();
  });
});

describe('mergeDecision', () => {
  it('review needs an approval; green-ci does not', () => {
    const unapproved = green({ reviewDecision: 'REVIEW_REQUIRED' });
    expect(mergeDecision(unapproved, [], 'review')).toEqual({
      merge: false,
      reason: 'Waiting: needs an approving review.',
    });
    expect(mergeDecision(unapproved, [], 'green-ci')).toEqual({ merge: true, via: 'merge', method: 'squash' });
    expect(mergeDecision(green(), [], 'review')).toEqual({ merge: true, via: 'merge', method: 'squash' });
  });

  it('never merges under never', () => {
    expect(mergeDecision(green(), [], 'never')).toEqual({ merge: false, reason: 'awaiting human merge' });
  });

  it('refuses on a hold label, case-insensitively, in every mode', () => {
    for (const policy of ['review', 'green-ci'] as const) {
      expect(mergeDecision(green(), ['Human-Merge'], policy)).toMatchObject({
        merge: false,
        reason: expect.stringMatching(/Human-Merge/),
      });
      expect(mergeDecision(green(), ['ship-it'], policy, ['ship-it'])).toMatchObject({ merge: false });
    }
  });

  it('refuses pending or failing CI, a draft and a conflict under green-ci too', () => {
    for (const overrides of [
      { checks: [check('Build', 'pending')] },
      { checks: [check('Build', 'pass'), check('Lint', 'fail', false)] },
      { isDraft: true },
      { mergeable: 'CONFLICTING' as const },
    ]) {
      expect(mergeDecision(green(overrides), [], 'green-ci')).toMatchObject({ merge: false });
    }
  });
});

function fakeGh(answers: Record<string, string[]>): { gh: GhRunner; calls: string[] } {
  const calls: string[] = [];
  const gh: GhRunner = async args => {
    const key = `${args[0]} ${args[1]}`;
    calls.push(key);
    const queue = answers[key] ?? [];
    return queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? '[]');
  };
  return { gh, calls };
}

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe('runDeployCheck', () => {
  const target = { pr: REF, mergeSha: 'abc', workflow: 'deploy.yml', cwd: '/repo' };

  it('passes once the run succeeds', async () => {
    const { gh } = fakeGh({
      'run list': ['[{"status":"in_progress"}]', '[{"status":"completed","conclusion":"success"}]'],
    });
    expect(await runDeployCheck(gh, target, clock())).toEqual({ ok: true });
  });

  it('fails on a failed run', async () => {
    const { gh } = fakeGh({ 'run list': ['[{"status":"completed","conclusion":"failure","url":"u"}]'] });
    expect(await runDeployCheck(gh, target, clock())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/failure/),
    });
  });

  it('times out when the run never finishes', async () => {
    const { gh } = fakeGh({ 'run list': ['[]'] });
    expect(await runDeployCheck(gh, target, clock(), 60_000)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/did not finish/),
    });
  });

  it('waits for a queued PR to merge before reading its runs', async () => {
    const { gh, calls } = fakeGh({
      'pr view': ['{"state":"OPEN"}', '{"state":"MERGED","mergeCommit":{"oid":"m1"}}'],
      'run list': ['[{"status":"completed","conclusion":"success"}]'],
    });
    expect(await runDeployCheck(gh, { ...target, mergeSha: undefined }, clock())).toEqual({ ok: true });
    expect(calls).toEqual(['pr view', 'pr view', 'run list']);
  });
});

describe('runSmoke', () => {
  const deps = (status: number, fails = false) => ({
    fetch: async () => ({ status }),
    run: async () => {
      if (fails) throw new Error('exit 1');
    },
  });

  it('checks a URL for 2xx', async () => {
    expect(await runSmoke({ url: 'https://example.com' }, '/', deps(204))).toEqual({ ok: true });
    expect(await runSmoke({ url: 'https://example.com' }, '/', deps(502))).toMatchObject({ ok: false });
  });

  it('checks a command for exit 0', async () => {
    expect(await runSmoke({ command: 'true' }, '/', deps(200))).toEqual({ ok: true });
    expect(await runSmoke({ command: 'false' }, '/', deps(200, true))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/exit 1/),
    });
  });
});

describe('repoSlug', () => {
  it('reads owner/name from https and ssh remotes', () => {
    expect(repoSlug('https://github.com/Example-Org/widgets.git\n')).toBe('example-org/widgets');
    expect(repoSlug('git@github.com:example-org/widgets.git')).toBe('example-org/widgets');
    expect(repoSlug('https://gitlab.com/a/b')).toBeNull();
  });
});
