import { describe, expect, it, vi } from 'vitest';
import type { PrRef } from '@shared/pullRequest';
import { GhError, classifyGhFailure } from './gh';
import { PrGithub, batchQuery, mergeMethodFor, parseSnapshot } from './github';

const REF: PrRef = {
  owner: 'example-org',
  repo: 'widgets',
  number: 611,
  url: 'https://github.com/example-org/widgets/pull/611',
};

/** The shape `gh api graphql` returned for a real open PR, trimmed and renamed. */
function response(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      viewer: { login: 'octo-dev' },
      repository: {
        autoMergeAllowed: false,
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        viewerDefaultMergeMethod: 'MERGE',
        pullRequest: {
          number: 611,
          title: 'feat: <b>ladder</b>',
          url: REF.url,
          state: 'OPEN',
          isDraft: false,
          author: { login: 'octo-dev' },
          headRefName: 'feat/widget-ladder',
          headRefOid: 'abc123',
          baseRefName: 'main',
          additions: 157,
          deletions: 0,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'REVIEW_REQUIRED',
          autoMergeRequest: null,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name: 'Build',
                          status: 'IN_PROGRESS',
                          conclusion: null,
                          detailsUrl: 'https://github.com/example-org/widgets/actions/runs/1/job/2',
                          isRequired: true,
                          checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
                        },
                        {
                          __typename: 'CheckRun',
                          name: 'Lint',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS',
                          isRequired: false,
                        },
                        {
                          __typename: 'CheckRun',
                          name: 'Unit',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          isRequired: true,
                        },
                        {
                          __typename: 'CheckRun',
                          name: 'E2E',
                          status: 'COMPLETED',
                          conclusion: 'SKIPPED',
                          isRequired: false,
                        },
                        { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', isRequired: false },
                      ],
                    },
                  },
                },
              },
            ],
          },
          ...overrides,
        },
      },
    },
  };
}

describe('parseSnapshot', () => {
  it('reads the fields the bar draws and buckets every check', () => {
    const snapshot = parseSnapshot(REF, response(), 1000, false);
    expect(snapshot).toMatchObject({
      number: 611,
      title: 'feat: <b>ladder</b>',
      headRefName: 'feat/widget-ladder',
      additions: 157,
      deletions: 0,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      autoMergeArmed: false,
      viewer: 'octo-dev',
      fetchedAt: 1000,
    });
    expect(snapshot.checks.map(check => [check.name, check.bucket, check.required])).toEqual([
      ['Build', 'pending', true],
      ['Lint', 'pass', false],
      ['Unit', 'fail', true],
      ['E2E', 'skipped', false],
      ['deploy/preview', 'pending', false],
    ]);
    expect(snapshot.checks[0]).toMatchObject({ workflow: 'CI', url: expect.stringContaining('/actions/runs/1') });
    expect(snapshot.threads).toBeUndefined();
  });

  it('records the repo merge settings, preferring the viewer default when allowed', () => {
    const snapshot = parseSnapshot(REF, response(), 0, false);
    expect(snapshot.repoSettings).toEqual({
      autoMergeAllowed: false,
      allowedMethods: ['squash', 'merge'],
      defaultMethod: 'merge',
    });
    expect(mergeMethodFor(snapshot)).toBe('merge');
  });

  it('reads armed auto-merge and a merged state', () => {
    const snapshot = parseSnapshot(REF, response({ state: 'MERGED', autoMergeRequest: { enabledAt: 'x' } }), 0, false);
    expect(snapshot.state).toBe('MERGED');
    expect(snapshot.autoMergeArmed).toBe(true);
  });

  it('keeps only unresolved threads, reduced to their latest comment', () => {
    const raw = response({
      reviewThreads: {
        nodes: [
          { id: 't1', isResolved: true, comments: { nodes: [{ databaseId: 1, body: 'done' }] } },
          {
            id: 't2',
            isResolved: false,
            isOutdated: false,
            path: 'src/a.ts',
            line: 12,
            comments: {
              nodes: [
                { databaseId: 2, author: { login: 'reviewer' }, authorAssociation: 'MEMBER', body: 'rename', url: 'u' },
              ],
            },
          },
        ],
      },
    });
    expect(parseSnapshot(REF, raw, 0, true).threads).toEqual([
      {
        id: 't2',
        path: 'src/a.ts',
        line: 12,
        commentId: 2,
        author: 'reviewer',
        association: 'MEMBER',
        body: 'rename',
        url: 'u',
        outdated: false,
      },
    ]);
  });

  it("keeps each reviewer's latest review only while it requests changes", () => {
    const raw = response({
      latestReviews: {
        nodes: [
          {
            databaseId: 5,
            state: 'APPROVED',
            author: { login: 'a' },
            authorAssociation: 'MEMBER',
            body: 'ok',
            url: 'u5',
          },
          {
            databaseId: 6,
            state: 'CHANGES_REQUESTED',
            author: { login: 'b' },
            authorAssociation: 'MEMBER',
            body: 'fix it',
            url: 'u6',
          },
        ],
      },
    });
    expect(parseSnapshot(REF, raw, 0, true).changeRequests).toEqual([
      { reviewId: 6, author: 'b', association: 'MEMBER', body: 'fix it', url: 'u6' },
    ]);
    expect(parseSnapshot(REF, raw, 0, false).changeRequests).toBeUndefined();
  });

  it('reports a PR the repo does not have as not-found', () => {
    expect(() => parseSnapshot(REF, { data: { repository: { pullRequest: null } } }, 0, false)).toThrow(GhError);
  });
});

describe('PrGithub', () => {
  it('never passes --admin and pins a merge to the head it checked', async () => {
    const gh = vi.fn().mockResolvedValue('');
    const github = new PrGithub(gh);
    await github.merge(REF, 'squash', 'abc123');
    await github.enableAutoMerge(REF, 'merge');
    await github.disableAutoMerge(REF);
    const calls = gh.mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(calls).toEqual([
      `pr merge ${REF.url} --squash --match-head-commit abc123`,
      `pr merge ${REF.url} --auto --merge`,
      `pr merge ${REF.url} --disable-auto`,
    ]);
    expect(calls.join(' ')).not.toContain('--admin');
  });

  it('passes the owner and repo as strings', async () => {
    const gh = vi.fn().mockResolvedValue(JSON.stringify(batched(repository())));
    await new PrGithub(gh).snapshot(REF, { threads: false });
    const args = gh.mock.calls[0][0] as string[];
    expect(args[args.indexOf('o0=example-org') - 1]).toBe('-f');
    expect(args[args.indexOf('n0=widgets') - 1]).toBe('-f');
    expect(args).toContain('t0=false');
  });

  it('reads several pull requests in one gh call', async () => {
    const gh = vi.fn().mockResolvedValue(JSON.stringify(batched(repository(), repository({ number: 612 }))));
    const results = await new PrGithub(gh).snapshots([
      { ref: REF, threads: false },
      { ref: OTHER, threads: true },
    ]);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(results.map(result => (result instanceof GhError ? result.kind : result.number))).toEqual([611, 612]);
    expect((results[1] as { threads?: unknown[] }).threads).toEqual([]);
    const args = gh.mock.calls[0][0] as string[];
    expect(args).toEqual(expect.arrayContaining(['p0=611', 'p1=612', 't0=false', 't1=true']));
  });

  it('keeps the other answers when one pull request cannot be read', async () => {
    const body = {
      ...batched(repository(), { pullRequest: null }),
      errors: [{ type: 'NOT_FOUND', path: ['p1', 'pullRequest'], message: 'Could not resolve to a PullRequest.' }],
    };
    const gh = vi.fn().mockRejectedValue(new GhError('not-found', 'Could not resolve', JSON.stringify(body)));
    const [first, second] = await new PrGithub(gh).snapshots([
      { ref: REF, threads: false },
      { ref: OTHER, threads: false },
    ]);
    expect(first).toMatchObject({ number: 611, state: 'OPEN' });
    expect(second).toBeInstanceOf(GhError);
    expect((second as GhError).kind).toBe('not-found');
  });

  it('fails every pull request in the call when gh itself fails', async () => {
    const gh = vi.fn().mockRejectedValue(new GhError('unauthenticated', 'run gh auth login'));
    await expect(new PrGithub(gh).snapshots([{ ref: REF, threads: false }])).rejects.toMatchObject({
      kind: 'unauthenticated',
    });
  });

  it('names each pull request by its own variables in the query', () => {
    const query = batchQuery(2);
    expect(query).toContain('p1: repository(owner: $o1, name: $n1)');
    expect(query).toContain('isRequired(pullRequestNumber: $p1)');
    expect(query).toContain('@include(if: $t1)');
    expect(query.match(/viewer \{ login \}/g)).toHaveLength(1);
  });
});

const OTHER: PrRef = { ...REF, number: 612, url: 'https://github.com/example-org/widgets/pull/612' };

function repository(pullRequest: Record<string, unknown> = {}): Record<string, unknown> {
  const base = response().data.repository as Record<string, unknown>;
  return { ...base, pullRequest: { ...(base.pullRequest as Record<string, unknown>), ...pullRequest } };
}

function batched(...repositories: Record<string, unknown>[]) {
  return {
    data: { viewer: { login: 'octo-dev' }, ...Object.fromEntries(repositories.map((repo, i) => [`p${i}`, repo])) },
  };
}

describe('classifyGhFailure', () => {
  it('tells missing, signed-out and rate-limited apart', () => {
    expect(classifyGhFailure('', 'ENOENT')).toBe('missing');
    expect(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login', 4)).toBe('unauthenticated');
    expect(classifyGhFailure('gh: API rate limit exceeded for user ID 1. (HTTP 403)', 1)).toBe('rate-limited');
    expect(classifyGhFailure('GraphQL: Could not resolve to a PullRequest with the number of 9.', 1)).toBe('not-found');
    expect(classifyGhFailure('something else broke', 1)).toBe('failed');
  });
});
