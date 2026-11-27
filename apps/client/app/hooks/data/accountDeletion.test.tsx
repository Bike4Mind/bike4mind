// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { tearDownClientSession } from '@client/app/hooks/data/user';
import { useCancelAccountDeletion, useRequestAccountDeletion } from './accountDeletion';

const h = vi.hoisted(() => ({
  del: vi.fn(),
  post: vi.fn(),
  setCurrentUser: vi.fn(),
  resetTokens: vi.fn(),
  currentUser: null as Record<string, unknown> | null,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { delete: h.del, get: vi.fn(), post: h.post } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign((select: (s: unknown) => unknown) => select({ setCurrentUser: h.setCurrentUser }), {
    getState: () => ({ currentUser: h.currentUser, setCurrentUser: h.setCurrentUser }),
  }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: unknown) => unknown) => select({ resetTokens: h.resetTokens }),
}));
vi.mock('@client/app/hooks/data/user', () => ({ tearDownClientSession: vi.fn() }));

const replace = vi.fn();
const originalLocation = window.location;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const httpError = (status: number) =>
  new AxiosError('failed', undefined, undefined, undefined, { status } as AxiosResponse);

describe('useCancelAccountDeletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, replace } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('reloads to / after a successful cancel', async () => {
    h.del.mockResolvedValue({ status: 204 });
    const { result } = renderHook(() => useCancelAccountDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(replace).toHaveBeenCalledWith('/');
  });

  it('clears the persisted deletion before reloading so the app boots unlocked', async () => {
    h.currentUser = { id: 'u1', deletion: { scheduledFor: '2026-12-01T00:00:00.000Z' } };
    h.del.mockResolvedValue({ status: 204 });
    const { result } = renderHook(() => useCancelAccountDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(h.setCurrentUser).toHaveBeenCalledWith({ id: 'u1', deletion: null });
    expect(h.setCurrentUser.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0]);
    h.currentUser = null;
  });

  it('treats a 404 (nothing scheduled) as done and reloads to /', async () => {
    h.del.mockRejectedValue(httpError(404));
    const { result } = renderHook(() => useCancelAccountDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(replace).toHaveBeenCalledWith('/');
  });

  it('surfaces any other failure and does not reload', async () => {
    h.del.mockRejectedValue(httpError(500));
    const { result } = renderHook(() => useCancelAccountDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('useRequestAccountDeletion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tears the client session down after the request succeeds', async () => {
    h.post.mockResolvedValue({ data: { deletion: { scheduledFor: '2026-12-01T00:00:00.000Z' } } });
    const { result } = renderHook(() => useRequestAccountDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(h.post).toHaveBeenCalledWith('/api/account/deletion');
    expect(tearDownClientSession).toHaveBeenCalledWith({
      setCurrentUser: h.setCurrentUser,
      resetTokens: h.resetTokens,
      queryClient: expect.any(QueryClient),
    });
  });

  it('leaves the session alone when the request fails', async () => {
    h.post.mockRejectedValue(httpError(409));
    const { result } = renderHook(() => useRequestAccountDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(tearDownClientSession).not.toHaveBeenCalled();
  });
});
