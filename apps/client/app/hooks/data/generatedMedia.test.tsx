// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: vi.fn() },
}));

import { api } from '@client/app/contexts/ApiContext';
import { useGeneratedMediaUrls } from './generatedMedia';

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('useGeneratedMediaUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fetch without keys or without a session id', () => {
    const queryClient = newQueryClient();
    const { result: noKeys } = renderHook(() => useGeneratedMediaUrls('session-1', []), {
      wrapper: createWrapper(queryClient),
    });
    const { result: noSession } = renderHook(() => useGeneratedMediaUrls(undefined, ['a.png']), {
      wrapper: createWrapper(queryClient),
    });

    expect(api.post).not.toHaveBeenCalled();
    expect(noKeys.current.urls).toEqual({});
    expect(noSession.current.urls).toEqual({});
  });

  it('posts sorted, de-duplicated keys and returns the parsed url map', async () => {
    vi.mocked(api.post).mockResolvedValue({
      data: { urls: { 'a.png': 'https://s3.test/a.png?sig=1' }, expiresAt: '2026-10-15T12:00:00.000Z' },
    });
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useGeneratedMediaUrls('session-1', ['b.png', 'a.png', 'b.png']), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.urls).toEqual({ 'a.png': 'https://s3.test/a.png?sig=1' }));
    expect(api.post).toHaveBeenCalledWith('/api/sessions/session-1/generated-media', { keys: ['a.png', 'b.png'] });
    expect(queryClient.getQueryCache().getAll()[0].queryKey).toEqual([
      'generatedMediaUrls',
      'session-1',
      ['a.png', 'b.png'],
    ]);
  });

  it('refetches under a new query key when a key arrives mid-stream', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { urls: {}, expiresAt: '2026-10-15T12:00:00.000Z' } });
    const queryClient = newQueryClient();

    const { rerender } = renderHook(({ keys }) => useGeneratedMediaUrls('session-1', keys), {
      initialProps: { keys: ['a.png'] },
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

    rerender({ keys: ['a.png', 'b.mp4'] });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  });
});
