import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreditHolderType, type IPlatformUsageDashboardResponse } from '@bike4mind/common';

const mockGet = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}));

import { usePlatformUsage, type PlatformUsageFilters } from './usePlatformUsage';

const responseFor = (days: number): IPlatformUsageDashboardResponse => ({
  days,
  overTime: [],
  byFeature: [],
  byConsumer: [],
  byModel: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
  endpoints: null,
  endpointWindowDays: days,
});

const renderUsageHook = (initialFilters: PlatformUsageFilters) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook((filters: PlatformUsageFilters) => usePlatformUsage(filters), {
    wrapper,
    initialProps: initialFilters,
  });
};

describe('usePlatformUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation(async (_url: string, config: { params: { days: number } }) => ({
      data: responseFor(config.params.days),
    }));
  });

  it('requests the admin endpoint with the filters as params and returns the payload', async () => {
    const { result } = renderUsageHook({ days: 30, source: 'api', ownerType: CreditHolderType.User });

    await waitFor(() => expect(result.current.data).toEqual(responseFor(30)));
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/api/admin/platform-usage', {
      params: { days: 30, source: 'api', ownerType: CreditHolderType.User },
    });
  });

  it('issues a new request when a filter changes instead of serving the cached result', async () => {
    const { result, rerender } = renderUsageHook({ days: 30, source: 'api' });
    await waitFor(() => expect(result.current.data).toBeDefined());

    rerender({ days: 30, source: 'api', ownerType: CreditHolderType.Organization });

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockGet).toHaveBeenLastCalledWith('/api/admin/platform-usage', {
      params: { days: 30, source: 'api', ownerType: CreditHolderType.Organization },
    });
  });

  it('surfaces a failed request as an error', async () => {
    mockGet.mockRejectedValue(new Error('Admin access required'));
    const { result } = renderUsageHook({ days: 7 });

    await waitFor(() => expect(result.current.error).toEqual(new Error('Admin access required')));
  });
});
