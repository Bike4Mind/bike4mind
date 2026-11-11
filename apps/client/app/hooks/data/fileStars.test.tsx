import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fabFileKeys } from './fabFileKeys';

const { apiGet, apiPost, apiDelete, toastError } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet, post: apiPost, delete: apiDelete } }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { useStarredFileIds, useToggleFileStar } from './fileStars';

const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => ({ starred: useStarredFileIds(), toggle: useToggleFileStar() }), { wrapper });
  return { result, queryClient, invalidate };
};

describe('file stars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({ data: { fileIds: ['a'] } });
  });

  it('stars a file through POST and refreshes the stars and every search', async () => {
    apiPost.mockResolvedValue({ data: {} });
    const { result, invalidate } = setup();
    await waitFor(() => expect(result.current.starred.has('a')).toBe(true));

    await act(() => result.current.toggle.mutateAsync({ fileId: 'b', starred: true }));

    expect(apiPost).toHaveBeenCalledWith('/api/files/b/favorite');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: fabFileKeys.starredIds });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: fabFileKeys.searchAll });
  });

  it('unstars through DELETE', async () => {
    apiDelete.mockResolvedValue({ data: {} });
    const { result } = setup();
    await waitFor(() => expect(result.current.starred.has('a')).toBe(true));

    await act(() => result.current.toggle.mutateAsync({ fileId: 'a', starred: false }));

    expect(apiDelete).toHaveBeenCalledWith('/api/files/a/favorite');
  });

  it('rolls the optimistic star back and tells the user when the request fails', async () => {
    apiPost.mockRejectedValue(new Error('boom'));
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.starred.has('a')).toBe(true));

    await act(async () => {
      await result.current.toggle.mutateAsync({ fileId: 'b', starred: true }).catch(() => undefined);
    });

    expect(toastError).toHaveBeenCalled();
    expect(queryClient.getQueryData<Set<string>>(fabFileKeys.starredIds)?.has('b')).toBe(false);
  });
});
