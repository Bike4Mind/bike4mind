import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockApiGet },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { currentUser: unknown }) => unknown) => {
    const state = { currentUser: { id: 'u1' } };
    return selector ? selector(state) : state;
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useModalsWithReleaseNotes } from './modalsWithReleaseNotes';

const note = {
  id: 'rn1',
  release_tag: 'v1.0.0',
  headline: 'Release',
  summary: 'Summary',
  published_at: '2026-01-01T00:00:00.000Z',
  items: [],
};

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

const route = (feed: () => Promise<unknown>) => (url: string) =>
  url.startsWith('/api/v1/whats-new') ? feed() : Promise.resolve({ data: [{ _id: 'm1', id: 'm1' }] });

describe('useModalsWithReleaseNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends release-note slides to the modals', async () => {
    mockApiGet.mockImplementation(route(() => Promise.resolve({ data: { data: [note], next_cursor: null } })));

    const { result } = renderHook(() => useModalsWithReleaseNotes(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.map(m => m._id)).toEqual(['m1', 'release-note:rn1']));
    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/whats-new?limit=5');
  });

  it('still returns the modals when the feed fails', async () => {
    mockApiGet.mockImplementation(route(() => Promise.reject(new Error('feed down'))));

    const { result } = renderHook(() => useModalsWithReleaseNotes(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.map(m => m._id)).toEqual(['m1']));
    expect(result.current.isPending).toBe(false);
  });

  it('does not wait for a slow feed before returning the modals', async () => {
    mockApiGet.mockImplementation(route(() => new Promise(() => {})));

    const { result } = renderHook(() => useModalsWithReleaseNotes(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.map(m => m._id)).toEqual(['m1']));
  });

  it('refetch resolves with both sources merged', async () => {
    mockApiGet.mockImplementation(route(() => Promise.resolve({ data: { data: [note], next_cursor: null } })));

    const { result } = renderHook(() => useModalsWithReleaseNotes(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let fresh: Awaited<ReturnType<typeof result.current.refetch>> | undefined;
    await act(async () => {
      fresh = await result.current.refetch();
    });
    expect(fresh?.data?.map(m => m._id)).toEqual(['m1', 'release-note:rn1']);
  });
});
