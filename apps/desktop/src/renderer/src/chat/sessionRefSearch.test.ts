import { describe, expect, it } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { findSessionsByRef } from './sessionRefSearch';

function session(id: string, title: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id,
    title,
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'code',
    messageCount: 1,
    ...extra,
  } as ChatSessionSummary;
}

const NO_PRS = new Map<string, PrSummary>();

describe('findSessionsByRef', () => {
  const titled = session('titled', '#1234 | PR#5678 | sidebar search', { updatedAt: '2026-03-01T00:00:00.000Z' });
  const bound = session('bound', 'Unrelated title');
  const mentioned = session('mentioned', 'Reading around', {
    githubRefs: [{ kind: 'issue', number: 1234, repo: 'acme/widgets' }],
  });
  const other = session('other', 'Upgrade to 1234 dependencies');
  const prs = new Map<string, PrSummary>([['bound', { number: 1234, state: 'open', repo: 'acme/widgets' }]]);

  it('returns nothing for a query that is not a ref', () => {
    expect(findSessionsByRef('sidebar', [titled], NO_PRS)).toEqual([]);
  });

  it('finds sessions by title, bound PR and mention, strongest first', () => {
    // Title and bound PR weigh the same; the more recent update wins between them.
    const hits = findSessionsByRef('1234', [mentioned, other, bound, titled], prs);
    expect(hits.map(hit => hit.session.id)).toEqual(['titled', 'bound', 'mentioned']);
    expect(hits.map(hit => hit.match.source)).toEqual(['title', 'pr', 'mention']);
  });

  it('tells issues from PRs when the query names a kind', () => {
    expect(findSessionsByRef('PR#5678', [titled, bound], prs).map(hit => hit.session.id)).toEqual(['titled']);
    expect(findSessionsByRef('issue 1234', [titled, bound], prs).map(hit => hit.session.id)).toEqual(['titled']);
  });

  it('finds a session from a pasted PR URL through its binding', () => {
    const hits = findSessionsByRef('https://github.com/acme/widgets/pull/1234', [bound, titled], prs);
    expect(hits[0].session.id).toBe('bound');
    expect(hits[0].match.ref).toEqual({ kind: 'pr', number: 1234, repo: 'acme/widgets' });
  });

  it('matches a ref in the branch', () => {
    const branched = session('branched', 'No number here', {
      project: { branch: 'fix/issue-42-crash' } as ChatSessionSummary['project'],
    });
    expect(findSessionsByRef('#42', [branched], NO_PRS)[0]?.match.source).toBe('branch');
  });

  it('breaks ties by the most recent update', () => {
    const older = session('older', 'PR#9 old', { updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = session('newer', 'PR#9 new', { updatedAt: '2026-02-01T00:00:00.000Z' });
    expect(findSessionsByRef('9', [older, newer], NO_PRS).map(hit => hit.session.id)).toEqual(['newer', 'older']);
  });
});
