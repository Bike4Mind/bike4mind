import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IFileTag, ITag } from '@bike4mind/common';

const mockPut = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { put: (...args: unknown[]) => mockPut(...args) },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { useUpdateFileTag } from './tag';

const CACHED_TAG = { id: 'tag-1', name: 'invoices', fileCount: 7 } as IFileTag;

describe('useUpdateFileTag', () => {
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const cachedTags = () => queryClient.getQueryData<IFileTag[]>(['file-tags']) ?? [];

  beforeEach(() => {
    mockPut.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['file-tags'], [CACHED_TAG]);
  });

  // PUT /api/files/tags/[id] returns only the fields tagUpdateSchema accepts, so replacing the
  // cached entry wholesale drops the recomputed fileCount and the sidebar badge reads (0).
  it('keeps the recomputed fileCount when the response omits it', async () => {
    mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'receipts', updatedAt: new Date() } });

    const { result } = renderHook(() => useUpdateFileTag(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'tag-1', name: 'receipts' } as ITag);
    });

    await waitFor(() => expect(cachedTags()[0].name).toBe('receipts'));
    expect(cachedTags()[0].fileCount).toBe(7);
  });

  it('lets the response win for fields it does return', async () => {
    mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'receipts', fileCount: 3 } });

    const { result } = renderHook(() => useUpdateFileTag(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'tag-1', name: 'receipts' } as ITag);
    });

    await waitFor(() => expect(cachedTags()[0].fileCount).toBe(3));
  });

  it('leaves other cached tags untouched', async () => {
    const other = { id: 'tag-2', name: 'receipts', fileCount: 2 } as IFileTag;
    queryClient.setQueryData(['file-tags'], [CACHED_TAG, other]);
    mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'renamed' } });

    const { result } = renderHook(() => useUpdateFileTag(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'tag-1', name: 'renamed' } as ITag);
    });

    await waitFor(() => expect(cachedTags()[0].name).toBe('renamed'));
    expect(cachedTags()[1]).toEqual(other);
  });
});
