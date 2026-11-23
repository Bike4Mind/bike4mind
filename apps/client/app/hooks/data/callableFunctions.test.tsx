import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallableFunctionsEnabled } from './callableFunctions';
import { CALLABLE_FUNCTIONS_STATUS_QUERY_KEY } from './queryKeys';

const h = vi.hoisted(() => ({ get: vi.fn(), accessToken: 'token' as string | null }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get } }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: { accessToken: string | null }) => unknown) => select({ accessToken: h.accessToken }),
}));

const renderEnabled = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useCallableFunctionsEnabled(), { wrapper }) };
};

describe('useCallableFunctionsEnabled', () => {
  beforeEach(() => {
    h.get.mockReset();
    h.accessToken = 'token';
  });

  it('is false while the status loads, then follows the route', async () => {
    let answer: (response: unknown) => void = () => {};
    h.get.mockReturnValue(new Promise(resolve => (answer = resolve)));
    const { result } = renderEnabled();

    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/api/callable-functions/status'));
    expect(result.current).toBe(false);

    answer({ data: { enabled: true } });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false when the status request fails', async () => {
    h.get.mockRejectedValue(new Error('Request failed with status code 404'));
    const { client, result } = renderEnabled();

    await waitFor(() => expect(client.getQueryState(CALLABLE_FUNCTIONS_STATUS_QUERY_KEY)?.status).toBe('error'));
    expect(result.current).toBe(false);
  });

  it('is false without a session and does not ask', () => {
    h.accessToken = null;
    const { result } = renderEnabled();

    expect(result.current).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
  });
});
