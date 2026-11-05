import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat';
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
      refsInText('see https://github.com/acme/widgets/issues/4 and https://github.com/acme/widgets/pull/new/my-branch')
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
