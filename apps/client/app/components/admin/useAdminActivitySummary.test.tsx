import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminActivitySummary } from './useAdminActivitySummary';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));

const summary = {
  windowStart: '2026-10-15T00:00:00.000Z',
  windowEnd: '2026-10-21T12:00:00.000Z',
  totalEvents: 1003,
  timeSeriesData: [{ date: '2026-10-21', count: 1003 }],
  categoryBreakdown: [{ category: 'Session', count: 1003, percentage: 100 }],
  topEvents: [{ eventName: 'Session Created', category: 'Session', count: 1003 }],
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useAdminActivitySummary(), { wrapper });
}

describe('useAdminActivitySummary', () => {
  beforeEach(() => get.mockReset());

  it('loads the summary endpoint and refreshes across UTC midnight', async () => {
    get.mockResolvedValueOnce({ data: summary });
    const { result } = setup();
    await waitFor(() => expect(result.current.data?.totalEvents).toBe(1003));
    expect(get).toHaveBeenCalledExactlyOnceWith('/api/admin/activity-summary');

    get.mockResolvedValueOnce({ data: { ...summary, windowStart: '2026-10-16T00:00:00.000Z' } });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.windowStart).toBe('2026-10-16T00:00:00.000Z'));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed response as an error rather than reporting no activity', async () => {
    get.mockResolvedValueOnce({ data: {} });
    const { result } = setup();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
