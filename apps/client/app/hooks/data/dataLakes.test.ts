import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BrowsePublicDataLakesResult, PublicDataLakeSummary } from '@bike4mind/common';
// Mocked below (vi.mock is hoisted); imported so the refusal-toast assertion can read the spy.
import { toast } from 'sonner';

/**
 * Offset paging for the public-lake discovery catalog. The regression this guards: `limit` used
 * to grow with each load-more (24 -> 48 -> 72), so the third click exceeded the route's max-limit
 * cap of 60 (pages/api/data-lakes/public.ts) and 422'd. `limit` must stay fixed and `offset` must
 * be what advances. 24 and 60 are deliberately literal here rather than imported from the hook /
 * the route - a self-referential assertion could not observe the regression.
 */

const apiGet = vi.fn();
const apiDelete = vi.fn();
const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));
// dataLakes.ts value-imports these at module load for its OTHER hooks; useBrowsePublicDataLakes
// touches none of them, and AccountSelector alone would pull in MUI Joy plus two React contexts.
// The stub is callable (zustand-style) with a getState property: useDuplicatePrefixLake calls
// it as a selector hook, activeOrgId reads getState.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/components/Credits/AccountSelector', () => {
  const useSelectedAccount = (selector: (s: { selectedAccount: undefined }) => unknown) =>
    selector({ selectedAccount: undefined });
  useSelectedAccount.getState = () => ({ selectedAccount: undefined });
  return { useSelectedAccount };
});
vi.mock('@client/app/hooks/useGearsStatus', () => ({ invalidateGearsStatusWhileLocked: () => {} }));

import {
  __resetPurgingLakesForTests,
  INITIAL_REBUILD_POLL_STATE,
  nextRebuildPoll,
  useBrowsePublicDataLakes,
  useCleanupDataLake,
  useDataLakeSpend,
  useDuplicatePrefixLake,
  useGetDeletedDataLakes,
  useRemoveFileFromDataLake,
  useApplyTaxonomySuggestions,
  useRechunkDataLake,
  useSetLakeVisibility,
  useArchiveDataLake,
  useTransferLakeOwnership,
} from './dataLakes';

const PAGE_SIZE = 24;

const summary = (id: string): PublicDataLakeSummary => ({
  id,
  slug: `lake-${id}`,
  name: `Lake ${id}`,
  fileTagPrefix: 'lake:',
  fileCount: 0,
  totalSizeBytes: 0,
  isOwn: false,
  canManage: false,
});

// api.get is axios-shaped, so the payload is double-nested: { data: { data, total } }.
const pageResponse = (count: number, total: number, startAt = 0): { data: BrowsePublicDataLakesResult } => ({
  data: {
    data: Array.from({ length: count }, (_, i) => summary(`lk${startAt + i}`)),
    total,
  },
});

const mountBrowse = (initialSearch = '') => {
  // A fresh client per mount - a shared one would serve the next test from cache and fire no request.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(({ search }: { search: string }) => useBrowsePublicDataLakes(search), {
    wrapper,
    initialProps: { search: initialSearch },
  });
};

const requestedUrls = (): string[] => apiGet.mock.calls.map(call => call[0] as string);
const paramsOf = (url: string) => new URL(url, 'http://test.local').searchParams;

describe('useBrowsePublicDataLakes', () => {
  beforeEach(() => {
    // mockReset (not mockClear) so a previous test's mockResolvedValueOnce queue cannot leak.
    apiGet.mockReset();
    apiGet.mockResolvedValue(pageResponse(PAGE_SIZE, 100));
  });

  it('requests the first page at a fixed limit and offset 0', async () => {
    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrls()).toEqual(['/api/data-lakes/public?limit=24&offset=0']);
  });

  it('trims the search term and sends it as q', async () => {
    const { result } = mountBrowse('  sales  ');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrls()[0]).toBe('/api/data-lakes/public?q=sales&limit=24&offset=0');
  });

  it('omits q entirely for a whitespace-only search', async () => {
    const { result } = mountBrowse('   ');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(paramsOf(requestedUrls()[0]).has('q')).toBe(false);
  });

  it('advances offset, not limit, on the second page', async () => {
    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(requestedUrls()[1]).toBe('/api/data-lakes/public?limit=24&offset=24');
  });

  it('keeps limit fixed across a deep load-more', async () => {
    apiGet
      .mockResolvedValueOnce(pageResponse(PAGE_SIZE, 100, 0))
      .mockResolvedValueOnce(pageResponse(PAGE_SIZE, 100, 24))
      .mockResolvedValueOnce(pageResponse(PAGE_SIZE, 100, 48));

    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));

    const limits = requestedUrls().map(url => paramsOf(url).get('limit'));
    const offsets = requestedUrls().map(url => paramsOf(url).get('offset'));

    // The old bug summed the page size into `limit` (24 -> 48 -> 72), so the THIRD load-more blew
    // past the route's max of 60 (public.ts:12). Assert the cap itself, before the exact-equality
    // check below, so a regression fails on the real consequence rather than on equality alone.
    limits.forEach(limit => expect(Number(limit)).toBeLessThanOrEqual(60));
    expect(limits).toEqual(['24', '24', '24']);
    expect(offsets).toEqual(['0', '24', '48']);
  });

  it('stops paging once the loaded count reaches the total', async () => {
    apiGet.mockResolvedValue(pageResponse(10, 10));
    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('restarts at offset 0 when the search term changes', async () => {
    const { result, rerender } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    rerender({ search: 'sales' });
    // keepPreviousData holds the prior pages for a tick, so gate on the recorded request rather
    // than on result.current.data.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(requestedUrls()[2]).toBe('/api/data-lakes/public?q=sales&limit=24&offset=0');
  });
});

describe('useRemoveFileFromDataLake cache invalidation', () => {
  it('invalidates every tag-derived view, not just the lake file list', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    apiDelete.mockResolvedValueOnce({ data: { success: true, fileCount: 0, totalSizeBytes: 0 } });

    const { result } = renderHook(() => useRemoveFileFromDataLake('lake1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('f1');
    });

    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['dataLakeFiles', 'lake1']));
    expect(keys).toContain(JSON.stringify(['data-lakes']));
    // Removal drops the file's tags under the lake prefix, so the tag tree and the article
    // surfaces are stale too. Bare key prefixes: both are keyed by a source discriminator,
    // and a fully-specified key would refresh only one of the two surfaces.
    expect(keys).toContain(JSON.stringify(['dataLakeTagCounts']));
    expect(keys).toContain(JSON.stringify(['dataLakeArticles']));
    // The bare file-tags prefix, not ['file-tags','counts']: the tag list itself carries a
    // fileCount derived from the files holding each tag, and invalidating only the longer
    // key leaves that list stale. Prefix matching covers the counts endpoint too.
    expect(keys).toContain(JSON.stringify(['file-tags']));
  });
});

/**
 * The purge is queued, not done: POST .../lifecycle {action:'cleanup'} answers 202 and the sweep
 * runs in a background consumer, so GET /api/data-lakes/deleted still returns the lake for a
 * while afterwards. That is why these tests mock the endpoint to keep returning BOTH lakes - a
 * refetch on the purge path is guaranteed to see the pre-sweep truth and put the row back (#1487).
 */
describe('useCleanupDataLake queued purge', () => {
  const deletedLake = (id: string) => ({ id, name: `Lake ${id}`, fileTagPrefix: `${id}:` });
  const listing = (...ids: string[]) => ({ data: { data: ids.map(deletedLake) } });

  // The pending-purge map behind this behavior is module-scoped (session-scoped by design: it must
  // survive the Deleted section remounting), so it is reset per case below. Ids stay distinct per
  // case anyway, so a leak would show up as a wrong assertion rather than as passing by luck.
  const mountPurgeSurface = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    const view = renderHook(() => ({ deleted: useGetDeletedDataLakes(true), cleanup: useCleanupDataLake() }), {
      wrapper,
    });
    return { ...view, queryClient, invalidate };
  };

  // Any refetch the purge triggers resolves immediately here, so one macrotask is enough for it
  // to have landed - which is what makes "it never happened" a real assertion rather than a race.
  const settle = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

  const deletedFetchCount = () => apiGet.mock.calls.filter(call => call[0] === '/api/data-lakes/deleted').length;

  beforeEach(() => {
    __resetPurgingLakesForTests();
    apiGet.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ data: { success: true, queued: true } });
  });

  it('removes the purged lake from the expanded list and keeps it gone', async () => {
    apiGet.mockResolvedValue(listing('lk1', 'lk2'));
    const { result, invalidate } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk1');
    });
    await settle();

    expect(apiPost).toHaveBeenCalledWith('/api/data-lakes/lk1/lifecycle', { action: 'cleanup' });
    expect(result.current.deleted.data).toEqual([deletedLake('lk2')]);
    // Exactly the mount fetch: a second GET would have re-added the still-soft-deleted lk1.
    expect(deletedFetchCount()).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('brings the row back on the next fetch when the consumer releases a guard-refused purge (#1744)', async () => {
    // The case the server-side release exists to recover, and the one a prune that ALSO required
    // absence could never reach: the sweep's guard refused the purge, the consumer released the
    // lake back to 'deleted', so the server lists it again. A response from a request that started
    // after the purge is authoritative either way - still listed means released, and the row must
    // reappear rather than stay hidden in this tab until a full page reload.
    apiGet.mockResolvedValue(listing('lk9', 'lk10'));
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk9');
    });
    await settle();
    expect(result.current.deleted.data).toEqual([deletedLake('lk10')]);

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['data-lakes', 'deleted'] });
    });
    await settle();
    expect(result.current.deleted.data).toEqual([deletedLake('lk9'), deletedLake('lk10')]);
  });

  it('invalidates no key that prefix-matches the deleted list', async () => {
    apiGet.mockResolvedValue(listing('lk3', 'lk4'));
    const { result, invalidate } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk3');
    });
    await settle();

    // Literal keys on purpose (the parity convention of this file). ['data-lakes'] is the trap:
    // it PREFIX-matches ['data-lakes','deleted'], so invalidating the lake list here would
    // refetch the deleted list and undo the removal above just as surely as naming it directly.
    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).not.toContain(JSON.stringify(['data-lakes']));
    expect(keys).not.toContain(JSON.stringify(['data-lakes', 'deleted']));
  });

  it('stays gone when a sibling mutation refetches the list before the sweep has run', async () => {
    // The realistic trigger: every other lake mutation invalidates dataLakeKeys.list, which
    // prefix-matches this key, and re-expanding the section refetches too. Since #1744 the accept
    // claims 'purging' BEFORE the route answers, so any refetch that starts after the mutation
    // resolves answers WITHOUT the lake - the row stays gone because the server says so, which is
    // what makes this survivable without the client map.
    apiGet.mockResolvedValueOnce(listing('lk5', 'lk6'));
    apiGet.mockResolvedValue(listing('lk6'));
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk5');
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    });
    await settle();

    expect(deletedFetchCount()).toBe(2); // the refetch really happened
    expect(result.current.deleted.data).toEqual([deletedLake('lk6')]);
  });

  it('lets a fetch that was already in flight land, and still hides the purged row', async () => {
    // Ordering the other way round from the test above: a sibling mutation (e.g. restoring another
    // lake) has already started a refetch when the purge resolves. Cancelling that fetch would
    // revert the query to its pre-fetch snapshot and strand the OTHER lake under Deleted, so the
    // fetch is allowed to finish - the queryFn filter is what keeps the purged row hidden.
    let releaseInFlight = (_value: unknown) => {};
    const inFlight = new Promise(resolve => {
      releaseInFlight = resolve;
    });

    apiGet.mockResolvedValueOnce(listing('lk9', 'lk10')); // mount
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    // A refetch starts and hangs. Its eventual answer reflects lk10 having been restored elsewhere.
    apiGet.mockImplementationOnce(async () => {
      await inFlight;
      return listing('lk9');
    });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    });
    await waitFor(() => expect(deletedFetchCount()).toBe(2));

    // Purge lk9 while that fetch is still outstanding, then let it land.
    await act(async () => {
      await result.current.cleanup.mutateAsync('lk9');
    });
    await act(async () => {
      releaseInFlight(null);
      await settle();
    });

    // The in-flight answer was applied (lk10 is gone because it was restored), and lk9 stays hidden
    // even though that response still listed it.
    expect(result.current.deleted.data).toEqual([]);
  });

  it('filters a response from a request that predates the purge, and does not prune on it', async () => {
    // The map's ONE remaining job since #1744, and the only case the server cannot cover: a fetch
    // that STARTED before the accept and lands after it, carrying a payload that still names the
    // lake because the server had not claimed 'purging' yet when it was taken. That response must
    // be filtered and must NOT prune - it settles nothing about the sweep.
    let releaseStale = (_value: unknown) => {};
    const stale = new Promise(resolve => {
      releaseStale = resolve;
    });

    apiGet.mockResolvedValueOnce(listing('lk11', 'lk12')); // mount
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    // In-flight fetch taken BEFORE the purge, so it still lists lk11 the way the pre-accept server
    // would have answered.
    apiGet.mockImplementationOnce(async () => {
      await stale;
      return listing('lk11', 'lk12');
    });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    });
    await waitFor(() => expect(deletedFetchCount()).toBe(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk11');
    });
    await act(async () => {
      releaseStale(null);
      await settle();
    });

    // Filtered on arrival, and the id is still tracked: pruning on a pre-purge request would have
    // un-hidden a row whose purge had only just been accepted.
    expect(deletedFetchCount()).toBe(2);
    expect(result.current.deleted.data).toEqual([deletedLake('lk12')]);
  });

  it('stops suppressing a purged id once the server no longer lists it', async () => {
    // Self-prune, so the set cannot grow forever or hide a lake indefinitely. Second phase asserts
    // the id was genuinely dropped rather than suppressed for the rest of the session.
    apiGet.mockResolvedValue(listing('lk7', 'lk8'));
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk7');
    });

    // Sweep finished: the endpoint stops listing lk7, which is what prunes it.
    apiGet.mockResolvedValue(listing('lk8'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes', 'deleted'] });
    });
    await waitFor(() => expect(result.current.deleted.data).toEqual([deletedLake('lk8')]));

    apiGet.mockResolvedValue(listing('lk7', 'lk8'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes', 'deleted'] });
    });
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));
  });
});

describe('useDataLakeSpend isForbidden', () => {
  const mountSpend = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(() => useDataLakeSpend('lake1', 30), { wrapper });
  };

  const axiosError = (status: number) => {
    const err = new Error(`request failed with status ${status}`) as Error & {
      isAxiosError: boolean;
      response: { status: number };
    };
    err.isAxiosError = true;
    err.response = { status };
    return err;
  };

  beforeEach(() => {
    apiGet.mockReset();
  });

  it('treats a 403 as forbidden', async () => {
    apiGet.mockRejectedValue(axiosError(403));
    const { result } = mountSpend();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(true);
  });

  // A transient 500 must not be treated as forbidden: retry:false means the Spend tab would
  // otherwise stay hidden until the query is invalidated, even though nothing is actually denied.
  it('does not treat a 500 as forbidden', async () => {
    apiGet.mockRejectedValue(axiosError(500));
    const { result } = mountSpend();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(false);
  });
});

describe('useDuplicatePrefixLake freshness', () => {
  it('refetches over a warm cache instead of trusting a stale list', async () => {
    const queryClient = new QueryClient();
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    // A display surface populated the cache moments ago with no colliding lake... (literal
    // key on purpose - the parity convention of this file)
    queryClient.setQueryData(['data-lakes'], []);
    // ...but a peer has since created one. The gate blocks the wizard's Next/Upload buttons,
    // so it must not trust the warm entry: its staleTime-0 override refetches on mount, and
    // the collision appears once the fresh list lands. With the list-surface defaults
    // (2 min staleTime) the warm read would be served as fresh and this test would time out.
    apiGet.mockResolvedValueOnce({
      data: { data: [{ id: 'lk1', name: 'Legal', fileTagPrefix: 'legal:', datalakeTag: 'datalake:legal' }] },
    });

    const { result } = renderHook(() => useDuplicatePrefixLake('legal:'), { wrapper });

    expect(result.current).toBeUndefined(); // the warm, collision-free list
    await waitFor(() => expect(result.current?.fileTagPrefix).toBe('legal:'));
    expect(apiGet).toHaveBeenCalledWith('/api/data-lakes');
  });
});

/**
 * Rebuild badge poll cadence. This logic has now carried two consecutive defects - it stopped
 * polling before the work it reported on had finished, and then, once both counts were summed, it
 * could never stop at all - and both shipped because nothing executed it. nextRebuildPoll is pure
 * precisely so this file can.
 */
describe('nextRebuildPoll', () => {
  const start = INITIAL_REBUILD_POLL_STATE;

  it('backs off as the backlog grows', () => {
    expect(nextRebuildPoll(1, start).interval).toBe(5_000);
    expect(nextRebuildPoll(51, start).interval).toBe(15_000);
    expect(nextRebuildPoll(201, start).interval).toBe(30_000);
  });

  it('stops immediately when there was never a backlog to drain', () => {
    expect(nextRebuildPoll(0, start).interval).toBe(false);
  });

  it('TERMINATES after the backlog clears, even though a failed file keeps failedCount above zero', () => {
    // The regression this exists to catch: gating the loop on underChunkedCount + failedCount. A
    // permanently-failed file never retries on its own, so that sum is pinned above zero and the
    // panel polls a full lake rescan every 5s forever. The count alone must be the loop condition.
    let state = nextRebuildPoll(3, start).next; // a backlog was seen
    let polls = 0;
    let interval = nextRebuildPoll(0, state).interval;
    while (interval !== false) {
      polls += 1;
      expect(polls).toBeLessThan(100); // fails loudly rather than hanging if it never terminates
      state = nextRebuildPoll(0, state).next;
      interval = nextRebuildPoll(0, state).interval;
    }
    expect(polls).toBeGreaterThan(0); // but it did keep polling for a while first
  });

  it('keeps polling briefly after the backlog clears, so a late failure still lands', () => {
    // underChunkedCount drops when a wave is RESET, minutes before those chunk jobs finish.
    const state = nextRebuildPoll(3, start).next;
    expect(nextRebuildPoll(0, state).interval).not.toBe(false);
  });

  it('restarts the settle window when a new backlog appears', () => {
    let state = nextRebuildPoll(3, start).next;
    state = nextRebuildPoll(0, state).next; // one settle poll consumed
    expect(nextRebuildPoll(5, state).next.settlePolls).toBe(0);
  });
});

/**
 * A config write adds a history row, and the History tab renders in the same modal that submitted
 * it. `useUpdateDataLake` invalidated that key from the start; these two did not, and only got away
 * with it because the history query pairs `staleTime: 0` with an `enabled` toggle that flips on tab
 * switch. That is an incidental refetch, not a guarantee - raising staleTime or dropping the toggle
 * would strand the row the owner just created. These pin the invalidation itself.
 *
 * The key is asserted as the literal `['dataLakeConfigHistory', 'lake1']` prefix rather than through
 * dataLakeKeys.configHistoryOf: building the expectation from the same helper the hook calls would
 * still pass if that helper's shape drifted away from what the query is actually keyed under.
 */
describe('config-history invalidation on the non-update config writes', () => {
  const mountWith = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { wrapper, invalidate };
  };
  const invalidatedKeys = (invalidate: ReturnType<typeof vi.spyOn>) =>
    invalidate.mock.calls.map(call => JSON.stringify((call[0] as { queryKey?: unknown })?.queryKey));

  it("useSetLakeVisibility invalidates the changed lake's history", async () => {
    const { wrapper, invalidate } = mountWith();
    apiPost.mockResolvedValueOnce({ data: { id: 'lake1' } });

    const { result } = renderHook(() => useSetLakeVisibility(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'lake1', visibility: 'public' });
    });

    expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(['dataLakeConfigHistory', 'lake1']));
  });

  it("a lifecycle action invalidates the acted-on lake's history", async () => {
    const { wrapper, invalidate } = mountWith();
    apiPost.mockResolvedValueOnce({ data: { success: true } });

    const { result } = renderHook(() => useArchiveDataLake(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('lake1');
    });

    expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(['dataLakeConfigHistory', 'lake1']));
  });

  it("a file removal invalidates that lake's history too - it can trigger the auto-activate row", async () => {
    // Inert in today's UI (this hook fires from the file wizard, where the History observer is
    // unmounted), so this pins the CONSISTENCY rather than a visible bug: every client path whose
    // write can record a config-history row invalidates that lake's history, with no per-path
    // reasoning about which ones currently matter.
    const { wrapper, invalidate } = mountWith();
    apiDelete.mockResolvedValueOnce({ data: { success: true, fileCount: 1, totalSizeBytes: 4 } });

    const { result } = renderHook(() => useRemoveFileFromDataLake('lake1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('f1');
    });

    expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(['dataLakeConfigHistory', 'lake1']));
  });

  it('scopes the invalidation to that one lake, never the whole history root', async () => {
    // configHistory sits outside the `list` prefix precisely so a rename does not refetch every
    // lake's history (see dataLakeKeys.ts). Invalidating the bare root here would undo that.
    const { wrapper, invalidate } = mountWith();
    apiPost.mockResolvedValueOnce({ data: { id: 'lake1' } });

    const { result } = renderHook(() => useSetLakeVisibility(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'lake1', visibility: 'private' });
    });

    expect(invalidatedKeys(invalidate)).not.toContain(JSON.stringify(['dataLakeConfigHistory']));
  });
});

describe('useRechunkDataLake cache invalidation', () => {
  it('refreshes lake HEALTH too, not just the rebuild badge', async () => {
    // A rebuild mass-mutates the exact per-file rollups health is computed from. The health query has
    // no refetchInterval and refetchOnWindowFocus:false, and its observer stays mounted while the
    // panel re-renders, so staleTime alone never refreshes it. Without this invalidation the badge
    // sits frozen for the whole rebuild while the "to rebuild" chip ticks to zero beside it - which
    // reads as "the rebuild accomplished nothing". The other two lake mutations already do both.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    apiPost.mockResolvedValueOnce({ data: { detected: 2, enqueued: 2, remaining: 0 } });

    const { result } = renderHook(() => useRechunkDataLake('lake1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(undefined);
    });

    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['dataLakeHealth', 'lake1']));
    expect(keys).toContain(JSON.stringify(['dataLakeRebuildStatus', 'lake1']));
    expect(keys).toContain(JSON.stringify(['dataLakeFiles', 'lake1']));
  });
});

describe('useTransferLakeOwnership cache invalidation', () => {
  it('refreshes the access view, the picker and the lake LIST - ownership decides canManage', async () => {
    // The list matters as much as the view: once the actor is no longer the owner, controls that
    // were theirs (transfer, the visibility expose gate) must disappear from the panel rather than
    // linger until something else happens to refetch. `dataLakeKeys.list` is the bare ['data-lakes']
    // prefix, so this one invalidation also covers the public/archived/deleted catalogs.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    apiPost.mockResolvedValueOnce({ data: { newOwnerUserId: 'u9', demotedUserIds: ['u1'] } });

    const { result } = renderHook(() => useTransferLakeOwnership(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'lake1', newOwnerUserId: 'u9' });
    });

    expect(apiPost).toHaveBeenCalledWith('/api/data-lakes/lake1/transfer-ownership', { newOwnerUserId: 'u9' });
    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['data-lakes', 'access', 'lake1']));
    expect(keys).toContain(JSON.stringify(['data-lakes', 'ownership-candidates', 'lake1']));
    expect(keys).toContain(JSON.stringify(['data-lakes']));
  });

  it("surfaces the server refusal text, not axios's generic status message", async () => {
    // These 400s are the actionable kind ("name another member"), and the modal keeps the dialog
    // open on failure - so the toast is the only thing telling the manager what to do differently.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    apiPost.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { data: { error: 'An organization admin cannot transfer a data lake to themselves' } },
      })
    );

    const { result } = renderHook(() => useTransferLakeOwnership(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: 'lake1', newOwnerUserId: 'self' })).rejects.toThrow();
    });

    expect(toast.error).toHaveBeenCalledWith('An organization admin cannot transfer a data lake to themselves');
  });
});

describe('useApplyTaxonomySuggestions result toast (#2093)', () => {
  // These branches produce the only sentence the user ever sees about an apply, and the batch is
  // 'applied' afterwards - apply requires 'ready' and re-analyze requires 'ready'|'failed', so
  // there is no in-product route back. A wrong message here is the user's last word on the batch.
  const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(() => useApplyTaxonomySuggestions('b1'), { wrapper });
  };

  // toast.* are module-level spies shared across this file, so calls accumulate without this.
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  it('does not claim "already up to date" when files silently lost their CAS check', async () => {
    // The review defect: 7 files already carried the tags and 3 needed them, but a concurrent tag
    // edit made all 3 miss. Reading only filesUpdated/unchanged renders a green "Tags already up to
    // date on 7 files" - an affirmative claim of completeness on a batch where 3 files were never
    // tagged, and the user cannot retry.
    apiPost.mockResolvedValueOnce({ data: { success: true, filesUpdated: 0, unchanged: 7, skipped: 3 } });

    const { result } = mount();
    await act(async () => {
      await result.current.mutateAsync([]);
    });

    expect(toast.success).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(
      'Tags already up to date on 7 files. 3 files could not be updated - changed while applying.'
    );
  });

  it('still reports a clean idempotent re-apply as a plain success', async () => {
    // The guard on the fix above: suppressing the false completeness claim must not turn the
    // genuine "nothing needed changing" case into a warning.
    apiPost.mockResolvedValueOnce({ data: { success: true, filesUpdated: 0, unchanged: 3, skipped: 0 } });

    const { result } = mount();
    await act(async () => {
      await result.current.mutateAsync([]);
    });

    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Tags already up to date on 3 files');
  });

  it('reports the split when some files were tagged and others already had them', async () => {
    apiPost.mockResolvedValueOnce({ data: { success: true, filesUpdated: 2, unchanged: 1, skipped: 0 } });

    const { result } = mount();
    await act(async () => {
      await result.current.mutateAsync([]);
    });

    expect(toast.success).toHaveBeenCalledWith('Tags applied to 2 files, 1 file already up to date');
  });

  it('falls through to the plain success arm when the server omits skipped (rolling deploy)', async () => {
    // A client on this build against a server that has not shipped `skipped` yet: `undefined > 0`
    // must read as "no skips", not throw and not warn.
    apiPost.mockResolvedValueOnce({ data: { success: true, filesUpdated: 4, unchanged: 0 } });

    const { result } = mount();
    await act(async () => {
      await result.current.mutateAsync([]);
    });

    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Tags applied to 4 files');
  });
});
