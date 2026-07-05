import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockApiGet },
}));

// A non-null currentUser keeps the query enabled so the queryFn actually runs.
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { currentUser: unknown }) => unknown) => {
    const state = { currentUser: { id: 'u1' } };
    return selector ? selector(state) : state;
  },
}));

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

import { useGetModals } from './modals';

const axiosErrorWithStatus = (status: number): AxiosError =>
  new AxiosError('request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
  } as AxiosResponse);

function createWrapper() {
  // Leave the hook's own `retry` config in force - don't override it here, since
  // its 401-skip behaviour is exactly what we're asserting.
  const queryClient = new QueryClient();
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return { Wrapper };
}

describe('useGetModals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not toast on a 401 (session-expiry is owned by the ApiContext interceptor)', async () => {
    mockApiGet.mockRejectedValue(axiosErrorWithStatus(401));

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useGetModals(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('does not retry on a 401 (interceptor already performs one refresh+retry)', async () => {
    mockApiGet.mockRejectedValue(axiosErrorWithStatus(401));

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useGetModals(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // A retry would produce a second call; the 401-skip keeps it at exactly one.
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it('toasts once on a genuine (non-401) failure', async () => {
    mockApiGet.mockRejectedValue(axiosErrorWithStatus(500));

    const { Wrapper } = createWrapper();
    renderHook(() => useGetModals(), { wrapper: Wrapper });

    // The toast fires on the first failed attempt, before retries are exhausted.
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith('Unable to load notifications. Please refresh the page.');
  });

  it('returns modal data on success without toasting', async () => {
    const modals = [{ id: 'm1' }];
    mockApiGet.mockResolvedValue({ data: modals });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useGetModals(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(modals);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
