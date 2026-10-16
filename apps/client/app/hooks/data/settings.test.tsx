import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

const put = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put } }));

import { useFloorAboveMeasuredWarning, useUpdateSettings } from './settings';
import { ADMIN_SETTINGS_ARRAY_QUERY_KEY, ADMIN_SETTINGS_QUERY_KEY } from './queryKeys';

describe('useFloorAboveMeasuredWarning', () => {
  const renderWarning = (key: Parameters<typeof useFloorAboveMeasuredWarning>[0], value: unknown) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ADMIN_SETTINGS_ARRAY_QUERY_KEY, [
      { settingName: 'defaultEmbeddingModel', settingValue: 'text-embedding-3-small' },
    ]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(() => useFloorAboveMeasuredWarning(key, value), { wrapper }).result.current;
  };

  it('warns about a minimum above the one measured for the default embedding model', () => {
    expect(renderWarning('forcedRetrievalMinSimilarityPct', 75)).toContain(
      '75% is above the 58% minimum measured for text-embedding-3-small'
    );
  });

  it('stays silent at the measured minimum, on a blank field, and on any other setting', () => {
    expect(renderWarning('forcedRetrievalMinSimilarityPct', 58)).toBeUndefined();
    expect(renderWarning('forcedRetrievalMinSimilarityPct', '')).toBeUndefined();
    expect(renderWarning('forcedRetrievalRelativeFloorPct', 95)).toBeUndefined();
  });
});

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
