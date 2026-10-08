import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

const put = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put } }));

import { useUpdateSettings } from './settings';
import { ADMIN_SETTINGS_QUERY_KEY } from './queryKeys';

describe('useUpdateSettings', () => {
  it('stays pending until the invalidated settings have been refetched', async () => {
    put.mockResolvedValue({ data: {} });
    let releaseRefetch: () => void = () => {};
    const refetchGate = new Promise<void>(resolve => {
      releaseRefetch = resolve;
    });
    let fetchCount = 0;
    const queryFn = async () => {
      fetchCount += 1;
      // Only the refetch triggered by the mutation waits on the gate.
      if (fetchCount > 1) await refetchGate;
      return {};
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // An active observer is required for invalidation to trigger a refetch.
    const { result } = renderHook(
      () => ({
        settingsQuery: useQuery({ queryKey: ADMIN_SETTINGS_QUERY_KEY, queryFn }),
        update: useUpdateSettings(),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.settingsQuery.isSuccess).toBe(true));

    act(() => {
      result.current.update.mutate({ key: 'videoGeneration', value: { enabledModels: {} } });
    });
    await waitFor(() => expect(fetchCount).toBe(2));
    expect(result.current.update.isPending).toBe(true);

    act(() => releaseRefetch());
    await waitFor(() => expect(result.current.update.isPending).toBe(false));
  });
});
