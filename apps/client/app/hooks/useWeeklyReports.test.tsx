import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetchCounterLogs = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/userAPICalls', () => ({ fetchCounterLogs }));

import { useWeeklyReports } from './useWeeklyReports';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const WEEKS = [
  { start: '2026-07-06', end: '2026-07-12' },
  { start: '2026-07-13', end: '2026-07-19' },
];

describe('useWeeklyReports', () => {
  beforeEach(() => {
    fetchCounterLogs.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sends nothing while no week is selected', () => {
    renderHook(() => useWeeklyReports([]), { wrapper });

    expect(fetchCounterLogs).not.toHaveBeenCalled();
  });

  it('resolves to no reports when refetched with no week selected', async () => {
    const { result } = renderHook(() => useWeeklyReports([]), { wrapper });

    const refetched = await result.current.refetch();

    expect(refetched.isError).toBe(false);
    expect(refetched.data).toEqual([]);
    expect(fetchCounterLogs).not.toHaveBeenCalled();
  });

  it('rejects when every selected week failed, so the tab can show its error card', async () => {
    fetchCounterLogs.mockRejectedValue(new Error('Request failed with status code 502'));

    const { result } = renderHook(() => useWeeklyReports(WEEKS), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: 'Request failed with status code 502' });
  });

  it('keeps the weeks that loaded and marks only the failed one', async () => {
    fetchCounterLogs
      .mockResolvedValueOnce({ reports: [{ report: 'Week one' }] })
      .mockRejectedValueOnce(new Error('timeout'));

    const { result } = renderHook(() => useWeeklyReports(WEEKS), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { startDate: '2026-07-13', endDate: '2026-07-19', error: 'timeout' },
      { startDate: '2026-07-06', endDate: '2026-07-12', report: 'Week one', aiInsights: undefined },
    ]);
  });
});
