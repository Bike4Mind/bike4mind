import React from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { adminActionCountsQueryKey, useAdminActionCounts } from './adminActionCounts';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const get = api.get as Mock;

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
};

describe('useAdminActionCounts', () => {
  it('stays idle when disabled', () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useAdminActionCounts({ enabled: false }), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });

  it('reads every count from one request under the shared key', async () => {
    get.mockResolvedValue({ data: { counts: { feedback: 2, deadLetters: null } } });
    const { wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(() => useAdminActionCounts({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ feedback: 2, deadLetters: null }));
    expect(get).toHaveBeenCalledExactlyOnceWith('/api/admin/action-counts');
    expect(queryClient.getQueryData(adminActionCountsQueryKey)).toEqual({ feedback: 2, deadLetters: null });
  });
});
