import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IFileTag, ITag } from '@bike4mind/common';

const mockPut = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    put: (...args: unknown[]) => mockPut(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { useCreateFileTag, useDeleteFileTag, useUpdateFileTag } from './tag';

const CACHED_TAG = { id: 'tag-1', name: 'invoices', color: 'blue', fileCount: 7 } as IFileTag;

describe('file tag mutations', () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const cachedTags = () => queryClient.getQueryData<IFileTag[]>(['file-tags']) ?? [];
  const invalidatedKeys = () => invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);

  beforeEach(() => {
    mockPut.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['file-tags'], [CACHED_TAG]);
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  });

  describe('useUpdateFileTag', () => {
    const rename = async () => {
      const { result } = renderHook(() => useUpdateFileTag(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ id: 'tag-1', name: 'receipts' } as ITag);
      });
    };

    it('merges the response instead of replacing the cached row', async () => {
      mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'receipts' } });

      await rename();

      await waitFor(() => expect(cachedTags()[0].name).toBe('receipts'));
      // tagUpdateSchema echoes back only what it accepted, so a wholesale swap would drop these.
      expect(cachedTags()[0].color).toBe('blue');
    });

    // A rename retags the files and can merge two tags into one, so the cached count and the
    // cached row set are both guesses. Invalidating the bare prefix is what makes the server win;
    // invalidating only ['file-tags','counts'] leaves the longer key matched and the list stale.
    it('invalidates the tag list so the derived count is refetched, not trusted', async () => {
      mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'receipts' } });

      await rename();

      expect(invalidatedKeys()).toContainEqual(['file-tags']);
    });

    // The rename rewrites the tag names stored on the files, so a cached file row still shows the
    // old name until something refetches it.
    it('invalidates the file list, because the rename retags the files', async () => {
      mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'receipts' } });

      await rename();

      expect(invalidatedKeys()).toContainEqual(['fabFiles']);
    });

    it('leaves other cached tags untouched', async () => {
      const other = { id: 'tag-2', name: 'receipts', fileCount: 2 } as IFileTag;
      queryClient.setQueryData(['file-tags'], [CACHED_TAG, other]);
      mockPut.mockResolvedValueOnce({ data: { id: 'tag-1', name: 'renamed' } });

      await rename();

      await waitFor(() => expect(cachedTags()[0].name).toBe('renamed'));
      expect(cachedTags()[1]).toEqual(other);
    });
  });

  describe('useDeleteFileTag', () => {
    const remove = async () => {
      const { result } = renderHook(() => useDeleteFileTag(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('tag-1');
      });
    };

    it('invalidates the tag list', async () => {
      mockDelete.mockResolvedValueOnce({});

      await remove();

      expect(invalidatedKeys()).toContainEqual(['file-tags']);
    });

    // Deleting a tag now strips the name off the files as well, so a cached file row still carries
    // a tag the server has removed. Without this the chips stay on screen until something else
    // happens to refetch.
    it('invalidates the file list, because the delete retags the files', async () => {
      mockDelete.mockResolvedValueOnce({});

      await remove();

      expect(invalidatedKeys()).toContainEqual(['fabFiles']);
    });
  });

  describe('useCreateFileTag', () => {
    // create seeds fileCount at 0, which is wrong whenever files already carry the name - tag
    // documents get auto-created by name elsewhere, and deleting one never untags the files.
    it('invalidates the tag list rather than trusting the seeded zero', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'tag-9', name: 'archive', fileCount: 0 } });

      const { result } = renderHook(() => useCreateFileTag(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ name: 'archive' } as Omit<
          ITag,
          'id' | 'userId' | 'createdAt' | 'updatedAt' | 'type'
        >);
      });

      expect(invalidatedKeys()).toContainEqual(['file-tags']);
    });
  });
});
