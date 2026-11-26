import { describe, expect, it } from 'vitest';
import type { ChatSessionSummary } from './chat';
import {
  compareSessionsForPage,
  decodeSessionCursor,
  encodeSessionCursor,
  pageSessions,
  sessionPageRequestSchema,
} from './sessionPage';

function summary(id: string, minute: number, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  const at = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  return {
    id,
    title: `Session ${id}`,
    mode: 'chat',
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
    ...extra,
  } as ChatSessionSummary;
}

/** `count` sessions, s0 newest. */
function list(count: number): ChatSessionSummary[] {
  return Array.from({ length: count }, (_, index) => summary(`s${index}`, 10_000 - index));
}

const ids = (sessions: readonly ChatSessionSummary[]) => sessions.map(session => session.id);

describe('pageSessions', () => {
  it('walks the whole list in order with no row repeated or skipped', () => {
    const sessions = list(25);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = pageSessions(sessions, { limit: 10, cursor });
      seen.push(...ids(page.sessions));
      expect(page.total).toBe(25);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids(sessions));
  });

  it('reports no next cursor when a page ends exactly at the end of the list', () => {
    const page = pageSessions(list(10), { limit: 10 });
    expect(page.sessions).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps the next page stable when a session moves to the top between requests', () => {
    const sessions = list(6);
    const first = pageSessions(sessions, { limit: 3 });
    // s4 is updated and jumps to the front; the cursor still points just past s2.
    const moved = [summary('s4', 20_000), ...sessions.filter(session => session.id !== 's4')];
    const second = pageSessions(moved, { limit: 3, cursor: first.nextCursor });
    expect(ids(second.sessions)).toEqual(['s3', 's5']);
    expect(second.nextCursor).toBeNull();
  });

  it('continues past a cursor whose session was deleted', () => {
    const sessions = list(6);
    const first = pageSessions(sessions, { limit: 3 });
    const without = sessions.filter(session => session.id !== 's2');
    expect(ids(pageSessions(without, { limit: 3, cursor: first.nextCursor }).sessions)).toEqual(['s3', 's4', 's5']);
  });

  it('breaks updatedAt ties by id so equal timestamps never straddle a page twice', () => {
    const sessions = ['b', 'a', 'c'].map(id => summary(id, 5)).sort(compareSessionsForPage);
    expect(ids(sessions)).toEqual(['a', 'b', 'c']);
    const first = pageSessions(sessions, { limit: 2 });
    expect(ids(pageSessions(sessions, { limit: 2, cursor: first.nextCursor }).sessions)).toEqual(['c']);
  });

  it('starts from the top for a cursor it cannot read', () => {
    expect(ids(pageSessions(list(3), { limit: 2, cursor: 'garbage' }).sessions)).toEqual(['s0', 's1']);
    expect(decodeSessionCursor('[1,2]')).toBeNull();
    expect(decodeSessionCursor(encodeSessionCursor({ updatedAt: 't', id: 'x' }))).toEqual({ updatedAt: 't', id: 'x' });
  });

  it('carries every pinned and live session on the first page only', () => {
    const sessions = list(10).map(session => (session.id === 's8' ? { ...session, pinned: true } : session));
    const live = new Set(['s9']);
    const first = pageSessions(sessions, { limit: 3 }, { liveIds: live });
    expect(ids(first.related)).toEqual(['s8', 's9']);
    const second = pageSessions(sessions, { limit: 3, cursor: first.nextCursor }, { liveIds: live });
    expect(second.related).toEqual([]);
  });

  it('carries the whole spawn family of every row in the slice', () => {
    const sessions = [
      summary('child', 100, { origin: { parentSessionId: 'parent', depth: 1, seedPrompt: '' } }),
      summary('other', 90),
      summary('parent', 10),
      summary('grandchild', 5, { origin: { parentSessionId: 'child', depth: 2, seedPrompt: '' } }),
      summary('sibling', 4, { origin: { parentSessionId: 'parent', depth: 1, seedPrompt: '' } }),
    ];
    const page = pageSessions(sessions, { limit: 1, cursor: null });
    expect(ids(page.sessions)).toEqual(['child']);
    expect(ids(page.related).sort()).toEqual(['grandchild', 'parent', 'sibling']);
  });

  it('survives a parent cycle in hand-edited files', () => {
    const sessions = [
      summary('a', 2, { origin: { parentSessionId: 'b', depth: 1, seedPrompt: '' } }),
      summary('b', 1, { origin: { parentSessionId: 'a', depth: 1, seedPrompt: '' } }),
    ];
    expect(ids(pageSessions(sessions, { limit: 1 }).related)).toEqual(['b']);
  });

  it('returns requested include ids from any page, ignoring unknown ones', () => {
    const page = pageSessions(list(10), { limit: 2, include: ['s7', 'gone', 's1'] });
    expect(ids(page.sessions)).toEqual(['s0', 's1']);
    expect(ids(page.related)).toEqual(['s7']);
  });

  it('searches titles across the whole list, paged, with no related rows', () => {
    const sessions = list(30).map((session, index) => ({
      ...session,
      title: index % 3 === 0 ? `Deploy ${index}` : 'x',
    }));
    const page = pageSessions(sessions, { limit: 4, query: '  DEPLOY ' });
    expect(page.total).toBe(10);
    expect(ids(page.sessions)).toEqual(['s0', 's3', 's6', 's9']);
    expect(page.related).toEqual([]);
    const next = pageSessions(sessions, { limit: 4, query: 'deploy', cursor: page.nextCursor });
    expect(ids(next.sessions)).toEqual(['s12', 's15', 's18', 's21']);
  });

  it('answers a zero limit with only the related rows, for an include-only fetch', () => {
    const page = pageSessions(list(5), { limit: 0, include: ['s3'] });
    expect(page.sessions).toEqual([]);
    expect(ids(page.related)).toEqual(['s3']);
  });
});

describe('sessionPageRequestSchema', () => {
  it('bounds the limit and the include list', () => {
    expect(sessionPageRequestSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(sessionPageRequestSchema.safeParse({ limit: -1 }).success).toBe(false);
    expect(sessionPageRequestSchema.safeParse({ limit: 1e9 }).success).toBe(false);
    expect(sessionPageRequestSchema.safeParse({ limit: 1, include: Array(51).fill('x') }).success).toBe(false);
  });
});
