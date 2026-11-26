// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import {
  SESSION_SEARCH_DEBOUNCE_MS,
  useSessionSearch,
  type SessionSearchFn,
  type SessionSearchResult,
} from './useSessionSearch';

const row = (id: string) => ({ id, title: id }) as ChatSessionSummary;

const roots: Root[] = [];

function mount(initialQuery: string, search: SessionSearchFn | undefined) {
  let latest: SessionSearchResult | undefined;
  let query = initialQuery;
  function Harness() {
    latest = useSessionSearch(query, search);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(<Harness />));
  return {
    current: () => latest as SessionSearchResult,
    setQuery: (next: string) => {
      query = next;
      act(() => root.render(<Harness />));
    },
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
});

describe('useSessionSearch', () => {
  it('asks the host once after the typing pause, not per keystroke', async () => {
    const search = vi.fn(async (q: string) => ({ sessions: [row(q)], total: 1 }));
    const { current, setQuery } = mount('d', search);
    setQuery('de');
    setQuery('dep');
    await act(async () => vi.advanceTimersByTime(SESSION_SEARCH_DEBOUNCE_MS - 1));
    expect(search).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('dep');
    expect(current().sessions.map(session => session.id)).toEqual(['dep']);
  });

  it('drops a reply for a query the user has since changed', async () => {
    const resolvers: Record<string, () => void> = {};
    const search = vi.fn(
      (q: string) =>
        new Promise<{ sessions: ChatSessionSummary[]; total: number }>(resolve => {
          resolvers[q] = () => resolve({ sessions: [row(q)], total: 1 });
        })
    );
    const { current, setQuery } = mount('old', search);
    await act(async () => vi.advanceTimersByTime(SESSION_SEARCH_DEBOUNCE_MS));
    setQuery('new');
    await act(async () => resolvers.old());
    expect(current().sessions).toEqual([]);
    await act(async () => vi.advanceTimersByTime(SESSION_SEARCH_DEBOUNCE_MS));
    await act(async () => resolvers.new());
    expect(current().sessions.map(session => session.id)).toEqual(['new']);
  });

  it('returns nothing for a blank query, and without a search function', async () => {
    const search = vi.fn(async () => ({ sessions: [row('x')], total: 1 }));
    const blank = mount('   ', search);
    await act(async () => vi.advanceTimersByTime(SESSION_SEARCH_DEBOUNCE_MS));
    expect(search).not.toHaveBeenCalled();
    expect(blank.current().sessions).toEqual([]);

    const local = mount('x', undefined);
    await act(async () => vi.advanceTimersByTime(SESSION_SEARCH_DEBOUNCE_MS));
    expect(local.current()).toEqual({ sessions: [], total: 0 });
  });
});
