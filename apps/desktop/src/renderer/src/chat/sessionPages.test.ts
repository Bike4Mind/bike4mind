import { describe, expect, it } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import {
  laggingHosts,
  mergeHostRows,
  NO_PAGING,
  pagedThrough,
  pagingWatermark,
  type SessionPaging,
} from './sessionPages';

const row = (id: string, updatedAt: string): ChatSessionSummary =>
  ({ id, title: id, mode: 'chat', messageCount: 1, createdAt: updatedAt, updatedAt }) as ChatSessionSummary;

const paged = (rows: ChatSessionSummary[], nextCursor: string | null): SessionPaging =>
  pagedThrough(NO_PAGING, { sessions: rows, nextCursor, total: rows.length + (nextCursor ? 10 : 0) });

describe('mergeHostRows', () => {
  // A busy host's first page reaches back to the 9th; a quiet one's to the 1st.
  const busy = [row('b10', '2026-10-10'), row('b9', '2026-10-09')];
  const quiet = [row('q8', '2026-10-08'), row('q5', '2026-10-05'), row('q1', '2026-10-01')];
  const byHost = new Map([
    ['local', busy],
    ['devbox', quiet],
  ]);

  it('holds back rows older than the host that has paged least far, while it has more', () => {
    const paging = new Map([
      ['local', paged(busy, 'more')],
      ['devbox', paged(quiet, 'more')],
    ]);
    expect(pagingWatermark(paging, ['local', 'devbox'])).toBe('2026-10-09');
    expect(mergeHostRows(byHost, paging, ['local', 'devbox']).map(entry => entry.id)).toEqual(['b10', 'b9']);
    expect(laggingHosts(paging, ['local', 'devbox'])).toEqual(['local']);
  });

  it('shows everything once the busy host has no more, or is not paging', () => {
    const done = new Map([
      ['local', paged(busy, null)],
      ['devbox', paged(quiet, 'more')],
    ]);
    const all = ['b10', 'b9', 'q8', 'q5', 'q1'];
    expect(mergeHostRows(byHost, done, ['local', 'devbox']).map(entry => entry.id)).toEqual(all);
    const offline = new Map([
      ['local', paged(busy, 'more')],
      ['devbox', paged(quiet, 'more')],
    ]);
    expect(mergeHostRows(byHost, offline, ['devbox']).map(entry => entry.id)).toEqual(all);
  });

  it('never holds back a row carried with a page, or a kept one', () => {
    const pinned = row('q-pinned', '2026-09-01');
    const kept = row('q-kept', '2026-09-02');
    const paging = new Map([
      ['local', paged(busy, 'more')],
      ['devbox', paged([...quiet, kept], 'more')],
    ]);
    const rows = new Map([
      ['local', busy],
      ['devbox', [...quiet, kept, pinned]],
    ]);
    expect(mergeHostRows(rows, paging, ['local', 'devbox'], new Set(['q-kept'])).map(entry => entry.id)).toEqual([
      'b10',
      'b9',
      'q-kept',
      'q-pinned',
    ]);
  });

  it('never holds back a child of a kept session', () => {
    const child = {
      ...row('b-child', '2026-09-01'),
      origin: { parentSessionId: 'b-open', depth: 1, seedPrompt: '' },
    } as ChatSessionSummary;
    const local = [...busy, child];
    const paging = new Map([
      ['local', paged(local, 'more')],
      ['devbox', paged(quiet, 'more')],
    ]);
    const rows = new Map([
      ['local', local],
      ['devbox', quiet],
    ]);
    expect(mergeHostRows(rows, paging, ['local', 'devbox'], new Set(['b-open'])).map(entry => entry.id)).toContain(
      'b-child'
    );
  });

  it('returns one host rows as they are', () => {
    const only = new Map([['local', busy]]);
    expect(mergeHostRows(only, new Map([['local', paged(busy, 'more')]]), ['local'])).toBe(busy);
  });
});

describe('pagedThrough', () => {
  it('adds the page rows and moves the oldest loaded time', () => {
    const first = paged([row('a', '2026-10-10')], 'c1');
    const second = pagedThrough(first, { sessions: [row('b', '2026-10-01')], nextCursor: null, total: 2 });
    expect(second).toMatchObject({ loaded: 2, nextCursor: null, total: 2, oldest: '2026-10-01' });
    expect([...second.pageIds]).toEqual(['a', 'b']);
  });
});
