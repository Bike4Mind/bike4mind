// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { useCancelAccountDeletion } from './accountDeletion';

const h = vi.hoisted(() => ({ del: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { delete: h.del, get: vi.fn(), post: vi.fn() } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: vi.fn() }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: vi.fn() }));
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
