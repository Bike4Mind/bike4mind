import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiKeyCompletionSource, IPlatformEndpointUsageResponse } from '@bike4mind/common';

const mockGet = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}));

import { useEndpointUsage } from './useEndpointUsage';

const responseFor = (source?: ApiKeyCompletionSource): IPlatformEndpointUsageResponse => ({
  source,
  windowDays: 90,
  endpoints: { byEndpoint: [], overTime: [] },
});

const renderEndpointHook = (initialSource?: ApiKeyCompletionSource) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook((source?: ApiKeyCompletionSource) => useEndpointUsage(source), {
    wrapper,
    initialProps: initialSource,
  });
};

describe('useEndpointUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation(async (_url: string, config: { params: { source?: ApiKeyCompletionSource } }) => ({
      data: responseFor(config.params.source),
    }));
  });

  it('requests the endpoints route with no filter by default', async () => {
    const { result } = renderEndpointHook();

    await waitFor(() => expect(result.current.data).toEqual(responseFor()));
    expect(mockGet).toHaveBeenCalledWith('/api/admin/platform-usage/endpoints', { params: { source: undefined } });
  });

  it('issues a new request when the source changes instead of serving the cached result', async () => {
    const { result, rerender } = renderEndpointHook();
    await waitFor(() => expect(result.current.data).toBeDefined());

    rerender('cli');

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockGet).toHaveBeenLastCalledWith('/api/admin/platform-usage/endpoints', { params: { source: 'cli' } });
  });

  it('surfaces a failed request as an error', async () => {
    mockGet.mockRejectedValue(new Error('Admin access required'));
    const { result } = renderEndpointHook();

    await waitFor(() => expect(result.current.error).toEqual(new Error('Admin access required')));
  });
});
