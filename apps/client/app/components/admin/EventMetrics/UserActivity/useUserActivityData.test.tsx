import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The page number is part of the server query now, so it has to be part of the react-query
 * key too - otherwise paging serves the cached first page forever.
 */
const fetchCounterLogs = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/userAPICalls', () => ({ fetchCounterLogs }));

import { useUserActivityData } from './useUserActivityData';
import { useAnalyticsStore, ALL_VALUE } from './store';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const lastCall = () => fetchCounterLogs.mock.calls[fetchCounterLogs.mock.calls.length - 1][0];

describe('useUserActivityData', () => {
  beforeEach(() => {
    fetchCounterLogs.mockReset();
    fetchCounterLogs.mockResolvedValue({ logs: [{ date: '2026-07-28' }], total: 4210 });
    useAnalyticsStore.setState({
      selectedOrganizations: [ALL_VALUE],
      exclusions: { noOrg: false, staff: false },
      userActivityFilters: { counterNameSearch: '', userEmailSearch: '' },
      metadataFilters: [],
      page: 1,
      limit: 25,
    });
  });

  it('requests the current page and page size', async () => {
    renderHook(() => useUserActivityData(), { wrapper });

    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalled());
    expect(lastCall()).toMatchObject({ page: 1, limit: 25 });
  });

  it('exposes the server total so the grid can show a page count', async () => {
    const { result } = renderHook(() => useUserActivityData(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({ total: 4210 });
  });

  it('refetches when the page changes rather than reusing the first page', async () => {
    const { rerender } = renderHook(() => useUserActivityData(), { wrapper });
    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalledTimes(1));

    useAnalyticsStore.getState().setPage(3);
    rerender();

    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalledTimes(2));
    expect(lastCall()).toMatchObject({ page: 3 });
  });

  it('sends the searches to the server', async () => {
    useAnalyticsStore.setState({ userActivityFilters: { counterNameSearch: 'Login', userEmailSearch: 'poy@' } });

    renderHook(() => useUserActivityData(), { wrapper });

    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalled());
    expect(lastCall()).toMatchObject({ counterName: 'Login', userEmail: 'poy@' });
  });

  it('refetches with the exclusion flags when a checkbox is toggled', async () => {
    const { rerender } = renderHook(() => useUserActivityData(), { wrapper });
    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalledTimes(1));
    expect(lastCall()).toMatchObject({ excludeNoOrg: false, excludeStaff: false });

    useAnalyticsStore.getState().toggleExclusion('staff');
    rerender();

    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalledTimes(2));
    expect(lastCall()).toMatchObject({ excludeNoOrg: false, excludeStaff: true });
  });

  it('sends metadata filters to the server', async () => {
    useAnalyticsStore.setState({ metadataFilters: [{ field: 'source', operator: 'exists' }] });

    renderHook(() => useUserActivityData(), { wrapper });

    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalled());
    expect(lastCall().metadataFilters).toEqual([{ field: 'source', operator: 'exists' }]);
  });

  it('keeps the previous page on screen while the next page is loading', async () => {
    fetchCounterLogs.mockResolvedValueOnce({ logs: [{ date: 'page-1' }], total: 4210 });
    const { result, rerender } = renderHook(() => useUserActivityData(), { wrapper });
    await waitFor(() => expect(result.current.data?.logs[0]).toMatchObject({ date: 'page-1' }));

    let resolveNextPage: (value: { logs: { date: string }[]; total: number }) => void = () => {};
    fetchCounterLogs.mockImplementationOnce(() => new Promise(resolve => (resolveNextPage = resolve)));
    useAnalyticsStore.getState().setPage(2);
    rerender();

    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data?.logs[0]).toMatchObject({ date: 'page-1' });
    expect(result.current.isPlaceholderData).toBe(true);

    resolveNextPage({ logs: [{ date: 'page-2' }], total: 4210 });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data?.logs[0]).toMatchObject({ date: 'page-2' });
  });

  it('sends nothing while disabled', async () => {
    renderHook(() => useUserActivityData({ enabled: false }), { wrapper });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchCounterLogs).not.toHaveBeenCalled();
  });

  it('never sends a report flag', async () => {
    renderHook(() => useUserActivityData(), { wrapper });

    await waitFor(() => expect(fetchCounterLogs).toHaveBeenCalled());
    expect(lastCall()).not.toHaveProperty('report');
    expect(lastCall()).not.toHaveProperty('weeklyReport');
  });
});
