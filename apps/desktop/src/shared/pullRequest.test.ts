import { describe, expect, it } from 'vitest';
import {
  ciSummary,
  findPullRequestUrls,
  parsePullRequestTarget,
  parsePullRequestUrl,
  prDisplayState,
  pullRequestFromShell,
  samePullRequest,
  type PrCheck,
} from './pullRequest';
import {
  PR_ATTENTIONS,
  isPrAttention,
  prAttentionOf,
  prAttentionRank,
  prIconStatus,
  type PrAttention,
  type PrAttentionInput,
} from './prAttention';
import {
  MAX_MENTIONED_REFS,
  matchRefs,
  mentionedRefs,
  parseRefQuery,
  refLabel,
  refsInBranch,
  refsInText,
  refsInTitle,
  type GithubRef,
  type SessionRefs,
} from './githubRefs';
import { DEFAULT_AUTO_FIX_ATTEMPTS, parseAutoFixAttempts } from './autoFixSetting';
import type { ChatMessage } from './chat';

describe('pullRequest', () => {
  const GH_PR_CREATE_OUTPUT = [
    'Warning: 2 uncommitted changes',
    '',
    'Creating pull request for feat/widget-ladder into main in example-org/widgets',
    '',
    'https://github.com/example-org/widgets/pull/611',
    '',
  ].join('\n');

  const FIRST_PUSH_OUTPUT = [
    'remote:',
    "remote: Create a pull request for 'feat/widget-ladder' on GitHub by visiting:",
    'remote:      https://github.com/example-org/widgets/pull/new/feat/widget-ladder',
    'remote:',
    'To https://github.com/example-org/widgets.git',
    ' * [new branch]      feat/widget-ladder -> feat/widget-ladder',
  ].join('\n');

  const LATER_PUSH_OUTPUT = [
    'remote:',
    'remote: View pull request for feat/widget-ladder:',
    'remote:      https://github.com/example-org/widgets/pull/611',
    'remote:',
    'To https://github.com/example-org/widgets.git',
    '   1a2b3c4..5d6e7f8  feat/widget-ladder -> feat/widget-ladder',
  ].join('\n');

  describe('pullRequestFromShell', () => {
    it('reads the URL gh pr create prints', () => {
      expect(pullRequestFromShell('gh pr create --fill', GH_PR_CREATE_OUTPUT)).toEqual({
        owner: 'example-org',
        repo: 'widgets',
        number: 611,
        url: 'https://github.com/example-org/widgets/pull/611',
      });
    });

    it('reads a gh pr create that is part of a chain', () => {
      expect(
        pullRequestFromShell('git push -u origin HEAD && gh pr create --title x', GH_PR_CREATE_OUTPUT)?.number
      ).toBe(611);
    });

    it('reads the existing PR a git push names', () => {
      expect(pullRequestFromShell('git push', LATER_PUSH_OUTPUT)?.number).toBe(611);
    });

    it('ignores the create-a-PR link a first push prints', () => {
      expect(pullRequestFromShell('git push -u origin feat/widget-ladder', FIRST_PUSH_OUTPUT)).toBeNull();
    });

    it('ignores PR URLs printed by commands that do not create or push one', () => {
      expect(pullRequestFromShell('gh pr list', GH_PR_CREATE_OUTPUT)).toBeNull();
      expect(pullRequestFromShell('cat CHANGELOG.md', 'see https://github.com/example-org/widgets/pull/12')).toBeNull();
      expect(pullRequestFromShell('echo gh pr created', GH_PR_CREATE_OUTPUT)).toBeNull();
    });

    it('takes the last URL when output mentions several', () => {
      const output =
        'related: https://github.com/example-org/widgets/pull/600\nhttps://github.com/example-org/widgets/pull/611\n';
      expect(pullRequestFromShell('gh pr create', output)?.number).toBe(611);
    });
  });

  describe('findPullRequestUrls', () => {
    it('finds URLs inside other text and stops at the number', () => {
      expect(findPullRequestUrls('(https://github.com/a-b/c.d/pull/7).').map(ref => ref.url)).toEqual([
        'https://github.com/a-b/c.d/pull/7',
      ]);
    });
  });

  describe('parsePullRequestUrl', () => {
    it('accepts a URL copied from the browser, tab and all', () => {
      expect(parsePullRequestUrl(' https://github.com/example-org/widgets/pull/42/checks?x=1 ')?.url).toBe(
        'https://github.com/example-org/widgets/pull/42'
      );
    });

    it('refuses anything that is not a GitHub PR', () => {
      expect(parsePullRequestUrl('https://github.com/example-org/widgets/issues/42')).toBeNull();
      expect(parsePullRequestUrl('https://example.com/example-org/widgets/pull/42')).toBeNull();
      expect(parsePullRequestUrl('https://github.com/example-org/widgets/pull/0')).toBeNull();
      expect(parsePullRequestUrl('javascript:alert(1)//github.com/a/b/pull/1')).toBeNull();
    });
  });

  describe('parsePullRequestTarget', () => {
    const repo = { owner: 'example-org', repo: 'widgets' };

    it('takes a URL, owner/repo#N, and a bare number in the given repo', () => {
      expect(parsePullRequestTarget('https://github.com/example-org/widgets/pull/42')?.number).toBe(42);
      expect(parsePullRequestTarget('other-org/gears#7')?.url).toBe('https://github.com/other-org/gears/pull/7');
      expect(parsePullRequestTarget('#12', repo)?.url).toBe('https://github.com/example-org/widgets/pull/12');
      expect(parsePullRequestTarget(' 12 ', repo)?.number).toBe(12);
    });

    it('refuses a bare number with no repo, and anything else', () => {
      expect(parsePullRequestTarget('#12')).toBeNull();
      expect(parsePullRequestTarget('#0', repo)).toBeNull();
      expect(parsePullRequestTarget('the second one', repo)).toBeNull();
      expect(parsePullRequestTarget('https://github.com/example-org/widgets/issues/42', repo)).toBeNull();
    });

    it('refuses a number past what a GitHub read can carry, in every form', () => {
      expect(parsePullRequestTarget('#2147483647', repo)?.number).toBe(2147483647);
      expect(parsePullRequestTarget('#2147483648', repo)).toBeNull();
      expect(parsePullRequestTarget('other-org/gears#9007199254740991')).toBeNull();
      expect(parsePullRequestTarget('https://github.com/example-org/widgets/pull/2147483648')).toBeNull();
      expect(findPullRequestUrls('https://github.com/example-org/widgets/pull/2147483648')).toEqual([]);
    });
  });

  describe('samePullRequest', () => {
    it('compares owner and repo without case', () => {
      expect(
        samePullRequest(
          { owner: 'Example-Org', repo: 'Widgets', number: 1, url: '' },
          { owner: 'example-org', repo: 'widgets', number: 1, url: '' }
        )
      ).toBe(true);
    });
  });

  describe('ciSummary', () => {
    const check = (bucket: PrCheck['bucket']): PrCheck => ({ name: bucket, bucket, required: false });

    it('lets a failure outrank anything still running', () => {
      expect(ciSummary([check('pass'), check('pending'), check('fail')])).toBe('fail');
      expect(ciSummary([check('pass'), check('pending')])).toBe('pending');
      expect(ciSummary([check('pass'), check('skipped')])).toBe('pass');
      expect(ciSummary([])).toBe('none');
    });
  });

  describe('prDisplayState', () => {
    it('shows an open PR in the merge queue as queued, and only an open one', () => {
      expect(prDisplayState('OPEN', false, true)).toBe('queued');
      expect(prDisplayState('OPEN', false, false)).toBe('open');
      expect(prDisplayState('OPEN')).toBe('open');
      expect(prDisplayState('OPEN', true, true)).toBe('draft');
      expect(prDisplayState('MERGED', false, true)).toBe('merged');
      expect(prDisplayState('CLOSED', false, true)).toBe('closed');
    });
  });
});

describe('prAttention', () => {
  const pass: PrCheck = { name: 'build', bucket: 'pass', required: true };
  const fail: PrCheck = { name: 'lint', bucket: 'fail', required: false };
  const pending: PrCheck = { name: 'test', bucket: 'pending', required: true };

  /** An approved, green, mergeable PR: `ready` until an override says otherwise. */
  function pr(overrides: Partial<PrAttentionInput> = {}): PrAttentionInput {
    return {
      state: 'OPEN',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      checks: [pass],
      ...overrides,
    };
  }

  describe('prAttentionOf', () => {
    it.each<[string, Partial<PrAttentionInput>, PrAttention]>([
      ['conflict (CONFLICTING)', { mergeable: 'CONFLICTING' }, 'conflict'],
      ['conflict (DIRTY)', { mergeStateStatus: 'DIRTY' }, 'conflict'],
      [
        'ciFailed, any failing check required or not',
        { checks: [pass, fail], mergeStateStatus: 'UNSTABLE' },
        'ciFailed',
      ],
      ['changesRequested', { reviewDecision: 'CHANGES_REQUESTED' }, 'changesRequested'],
      ['ciRunning', { checks: [pass, pending] }, 'ciRunning'],
      ['awaitingReview', { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }, 'awaitingReview'],
      ['approvedBlocked', { mergeStateStatus: 'BLOCKED' }, 'approvedBlocked'],
      ['blocked with no review required', { reviewDecision: null, mergeStateStatus: 'BLOCKED' }, 'approvedBlocked'],
      ['ready', {}, 'ready'],
      ['ready with no review required and no checks', { reviewDecision: null, checks: [] }, 'ready'],
      ['ready when behind (shown as a badge)', { mergeStateStatus: 'BEHIND' }, 'ready'],
      ['ready with hooks', { mergeStateStatus: 'HAS_HOOKS' }, 'ready'],
    ])('%s', (_name, overrides, expected) => {
      expect(prAttentionOf(pr(overrides))).toBe(expected);
    });

    it('says nothing while GitHub is still computing mergeability', () => {
      expect(prAttentionOf(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))).toBeNull();
    });

    it('is null for drafts and finished PRs', () => {
      expect(prAttentionOf(pr({ isDraft: true }))).toBeNull();
      expect(prAttentionOf(pr({ state: 'MERGED' }))).toBeNull();
      expect(prAttentionOf(pr({ state: 'CLOSED' }))).toBeNull();
    });

    it('ranks conflict > ciFailed > changesRequested > ciRunning > awaitingReview when several apply', () => {
      const everything = pr({
        mergeable: 'CONFLICTING',
        checks: [fail, pending],
        reviewDecision: 'CHANGES_REQUESTED',
      });
      expect(prAttentionOf(everything)).toBe('conflict');
      expect(prAttentionOf({ ...everything, mergeable: 'MERGEABLE' })).toBe('ciFailed');
      expect(prAttentionOf({ ...everything, mergeable: 'MERGEABLE', checks: [pending] })).toBe('changesRequested');
      expect(prAttentionOf(pr({ checks: [pending], reviewDecision: 'REVIEW_REQUIRED' }))).toBe('ciRunning');
      expect(prAttentionOf(pr({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }))).toBe(
        'awaitingReview'
      );
    });
  });

  describe('prIconStatus', () => {
    const full = { ...pr(), autoMergeArmed: false };

    it('adds behind and auto-merge only when they hold, and only for an open PR', () => {
      expect(prIconStatus(full, { queued: false, appAutoMerge: false })).toEqual({ state: 'open', attention: 'ready' });
      expect(
        prIconStatus(
          { ...full, mergeStateStatus: 'BEHIND', autoMergeArmed: true },
          { queued: false, appAutoMerge: false }
        )
      ).toEqual({ state: 'open', attention: 'ready', behind: true, autoMerge: true });
      expect(prIconStatus(full, { queued: false, appAutoMerge: true }).autoMerge).toBe(true);
      expect(
        prIconStatus({ ...full, isDraft: true, autoMergeArmed: true }, { queued: false, appAutoMerge: false })
      ).toEqual({ state: 'draft' });
      expect(prIconStatus(full, { queued: true, appAutoMerge: false })).toEqual({ state: 'queued' });
    });
  });

  describe('prAttentionRank', () => {
    it('orders open PRs by attention, then other live PRs, then none or finished', () => {
      const ranks = PR_ATTENTIONS.map(attention => prAttentionRank({ state: 'open', attention }));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(prAttentionRank({ state: 'draft' })).toBeGreaterThan(
        prAttentionRank({ state: 'open', attention: 'ready' })
      );
      expect(prAttentionRank(undefined)).toBeGreaterThan(prAttentionRank({ state: 'draft' }));
      expect(prAttentionRank({ state: 'merged' })).toBe(prAttentionRank(undefined));
    });

    it('guards stored values', () => {
      expect(isPrAttention('ciFailed')).toBe(true);
      expect(isPrAttention('green')).toBe(false);
      expect(isPrAttention(3)).toBe(false);
    });
  });
});

describe('githubRefs', () => {
  const NO_REFS: SessionRefs = { title: [], branch: [], pr: [], mention: [] };

  function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id: `m-${content.length}`, role, content, createdAt: '2026-01-01T00:00:00.000Z', ...extra } as ChatMessage;
  }

  describe('parseRefQuery', () => {
    it.each([
      ['1234', { kind: 'either', number: 1234 }],
      ['#1234', { kind: 'either', number: 1234 }],
      ['  #1234  ', { kind: 'either', number: 1234 }],
      ['PR#1234', { kind: 'pr', number: 1234 }],
      ['pr 1234', { kind: 'pr', number: 1234 }],
      ['pr1234', { kind: 'pr', number: 1234 }],
      ['Pull #1234', { kind: 'pr', number: 1234 }],
      ['issue #42', { kind: 'issue', number: 42 }],
      ['acme/widgets#1234', { kind: 'either', number: 1234, repo: 'acme/widgets' }],
      ['docs#42', { kind: 'either', number: 42, repo: 'docs' }],
      ['https://github.com/Acme/Widgets/pull/1234', { kind: 'pr', number: 1234, repo: 'acme/widgets' }],
      ['https://github.com/acme/widgets/pull/1234/files#diff-1', { kind: 'pr', number: 1234, repo: 'acme/widgets' }],
      ['https://github.com/acme/widgets/issues/42?q=1', { kind: 'issue', number: 42, repo: 'acme/widgets' }],
    ])('reads %j', (input, expected) => {
      expect(parseRefQuery(input)).toEqual(expected);
    });

    it.each(['', 'fix the build', 'pr', '#', '12abc', 'https://github.com/acme/widgets', '0', '#99999999999'])(
      'rejects %j',
      input => {
        expect(parseRefQuery(input)).toBeNull();
      }
    );
  });

  describe('refsInTitle', () => {
    it('reads the issue-then-PR convention', () => {
      expect(refsInTitle('#1234 | PR#5678 | sidebar search')).toEqual([
        { kind: 'issue', number: 1234 },
        { kind: 'pr', number: 5678 },
      ]);
    });

    it('reads a short repo prefix as the issue when a PR is named', () => {
      expect(refsInTitle('docs#42 | PR#5678 | topic')).toEqual([
        { kind: 'issue', number: 42, repo: 'docs' },
        { kind: 'pr', number: 5678 },
      ]);
    });

    it('keeps a lone #N ambiguous', () => {
      expect(refsInTitle('Fix #77 crash')).toEqual([{ kind: 'either', number: 77 }]);
    });

    it('reads URLs and owner/repo refs', () => {
      expect(refsInTitle('Review https://github.com/acme/widgets/pull/9 and acme/gears#3')).toEqual([
        { kind: 'pr', number: 9, repo: 'acme/widgets' },
        { kind: 'either', number: 3, repo: 'acme/gears' },
      ]);
    });

    it('ignores plain numbers and words that only start like a keyword', () => {
      expect(refsInTitle('Upgrade to v2 in 3 steps')).toEqual([]);
      expect(refsInTitle('projects#12')).toEqual([{ kind: 'either', number: 12, repo: 'projects' }]);
    });
  });

  describe('refsInBranch', () => {
    it('reads refs spelled out in a branch name', () => {
      expect(refsInBranch('fix/issue-56-thing')).toEqual([{ kind: 'issue', number: 56 }]);
      expect(refsInBranch('pr_12')).toEqual([{ kind: 'pr', number: 12 }]);
      expect(refsInBranch('gh-78/retry')).toEqual([{ kind: 'either', number: 78 }]);
    });

    it('ignores bare numbers and missing branches', () => {
      expect(refsInBranch('release/2026-01-05')).toEqual([]);
      expect(refsInBranch(undefined)).toEqual([]);
    });
  });

  describe('refsInText', () => {
    it('reads issue and PR URLs but not a create-PR link', () => {
      expect(
        refsInText(
          'see https://github.com/acme/widgets/issues/4 and https://github.com/acme/widgets/pull/new/my-branch'
        )
      ).toEqual([{ kind: 'issue', number: 4, repo: 'acme/widgets' }]);
    });

    it('reads gh commands with an optional repo flag', () => {
      expect(refsInText('gh pr view 12 --json title -R acme/widgets')).toEqual([
        { kind: 'pr', number: 12, repo: 'acme/widgets' },
      ]);
      expect(refsInText('gh issue view #34')).toEqual([{ kind: 'issue', number: 34 }]);
    });

    it('reads the issue a gh pr create body closes', () => {
      expect(refsInText('gh pr create --title "feat: x" --body "Adds x.\n\nCloses #321"')).toEqual([
        { kind: 'issue', number: 321 },
      ]);
    });

    it('reads closing keywords in linear time on a long run of whitespace', () => {
      const started = Date.now();
      refsInText(`gh pr create --body "Closes${' '.repeat(50_000)}x"`);
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('does not read closing keywords outside a PR create', () => {
      expect(refsInText('this fixes #321, see github.com docs')).toEqual([]);
    });

    it('skips text with no GitHub marker cheaply', () => {
      expect(refsInText('PR#12 is great')).toEqual([]);
    });
  });

  describe('mentionedRefs', () => {
    it('collects refs from messages and tool calls, first seen first, deduplicated', () => {
      const messages = [
        message('user', 'Please fix https://github.com/acme/widgets/issues/7'),
        message('assistant', 'On it.', {
          toolCalls: [
            {
              id: 't1',
              name: 'shell',
              input: { command: 'gh pr create --fill --body "Closes #7"' },
              preview: 'https://github.com/acme/widgets/pull/8',
            },
          ],
        } as unknown as Partial<ChatMessage>),
        message('assistant', 'Opened https://github.com/acme/widgets/pull/8'),
      ];
      expect(mentionedRefs(messages)).toEqual([
        { kind: 'issue', number: 7, repo: 'acme/widgets' },
        { kind: 'issue', number: 7 },
        { kind: 'pr', number: 8, repo: 'acme/widgets' },
      ]);
    });

    it('skips a listing that names many refs', () => {
      const listing = [1, 2, 3, 4, 5, 6].map(n => `https://github.com/acme/widgets/pull/${n}`).join('\n');
      expect(mentionedRefs([message('assistant', listing)])).toEqual([]);
    });

    it('caps what it keeps', () => {
      const messages = Array.from({ length: MAX_MENTIONED_REFS + 10 }, (_, n) =>
        message('user', `https://github.com/acme/widgets/issues/${n + 1}`)
      );
      expect(mentionedRefs(messages)).toHaveLength(MAX_MENTIONED_REFS);
    });
  });

  describe('matchRefs', () => {
    const issue: GithubRef = { kind: 'issue', number: 1234 };
    const pr: GithubRef = { kind: 'pr', number: 1234, repo: 'acme/widgets' };

    it('matches a bare number against either kind', () => {
      const query = parseRefQuery('1234')!;
      expect(matchRefs(query, { ...NO_REFS, title: [issue] })?.source).toBe('title');
      expect(matchRefs(query, { ...NO_REFS, pr: [pr] })?.source).toBe('pr');
    });

    it('keeps kinds apart when the query names one', () => {
      expect(matchRefs(parseRefQuery('pr 1234')!, { ...NO_REFS, title: [issue] })).toBeNull();
      expect(matchRefs(parseRefQuery('issue 1234')!, { ...NO_REFS, pr: [pr] })).toBeNull();
    });

    it('keeps repos apart when both are known', () => {
      expect(matchRefs(parseRefQuery('acme/gears#1234')!, { ...NO_REFS, pr: [pr] })).toBeNull();
      expect(matchRefs(parseRefQuery('acme/widgets#1234')!, { ...NO_REFS, pr: [pr] })).not.toBeNull();
    });

    it('matches a short repo name to the repo it abbreviates', () => {
      const query = parseRefQuery('https://github.com/acme/acme-docs/issues/42')!;
      expect(matchRefs(query, { ...NO_REFS, title: [{ kind: 'issue', number: 42, repo: 'docs' }] })).not.toBeNull();
      expect(matchRefs(query, { ...NO_REFS, title: [{ kind: 'issue', number: 42, repo: 'gears' }] })).toBeNull();
    });

    it('ranks a title or bound PR above a branch, and a branch above a mention', () => {
      const query = parseRefQuery('#1234')!;
      const title = matchRefs(query, { ...NO_REFS, title: [issue] })!.score;
      const branch = matchRefs(query, { ...NO_REFS, branch: [issue] })!.score;
      const mention = matchRefs(query, { ...NO_REFS, mention: [issue] })!.score;
      expect(title).toBeGreaterThan(branch);
      expect(branch).toBeGreaterThan(mention);
    });

    it('prefers the strongest source when a session carries the ref twice', () => {
      expect(matchRefs(parseRefQuery('1234')!, { ...NO_REFS, mention: [issue], title: [issue] })?.source).toBe('title');
    });

    it('rejects a different number', () => {
      expect(matchRefs(parseRefQuery('123')!, { ...NO_REFS, title: [issue] })).toBeNull();
    });
  });

  describe('refLabel', () => {
    it('says the kind and the short repo', () => {
      expect(refLabel({ kind: 'pr', number: 12, repo: 'acme/widgets' })).toBe('PR widgets#12');
      expect(refLabel({ kind: 'issue', number: 3 })).toBe('Issue #3');
      expect(refLabel({ kind: 'either', number: 9, repo: 'docs' })).toBe('docs#9');
    });
  });
});

describe('autoFixSetting', () => {
  describe('parseAutoFixAttempts', () => {
    it.each([1, 2, 5, 20])('keeps %d', value => {
      expect(parseAutoFixAttempts(value)).toBe(value);
    });

    it.each([undefined, null, '3', 0, -1, 21, 2.5, Number.NaN, Infinity])('reads %s as the default', value => {
      expect(parseAutoFixAttempts(value)).toBe(DEFAULT_AUTO_FIX_ATTEMPTS);
    });
  });
});
