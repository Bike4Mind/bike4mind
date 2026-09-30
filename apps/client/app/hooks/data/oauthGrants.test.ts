import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockGet = vi.fn();
const mockDelete = vi.fn();

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

import { useOAuthGrants, useRevokeOAuthGrant } from './oauthGrants';

const GRANTS = [
  { clientId: 'client-a', clientName: 'TestApp', scopes: ['openid'], approvedAt: '2026-06-15T00:00:00.000Z' },
];

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
};

describe('useOAuthGrants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches from GET /api/oauth/grants and unwraps the grants array', async () => {
    mockGet.mockResolvedValue({ data: { grants: GRANTS } });
    const { result } = renderHook(() => useOAuthGrants(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockGet).toHaveBeenCalledWith('/api/oauth/grants');
    expect(result.current.data).toEqual(GRANTS);
  });

  it('exposes isError when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useOAuthGrants(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useRevokeOAuthGrant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { grants: GRANTS } });
  });

  it('sends DELETE to the URL-encoded clientId path', async () => {
    mockDelete.mockResolvedValue({ data: { revoked: true, clientId: 'client-a' } });
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useRevokeOAuthGrant(), { wrapper });

    await act(async () => {
      result.current.mutate({ clientId: 'client-a/with-slash' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockDelete).toHaveBeenCalledWith('/api/oauth/grants/client-a%2Fwith-slash');
  });

  it('exposes isError and does not invalidate the query when the request fails', async () => {
    mockDelete.mockRejectedValue(new Error('server error'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    }

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRevokeOAuthGrant(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ clientId: 'client-a' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates the oauth-grants query on success', async () => {
    mockDelete.mockResolvedValue({ data: { revoked: true, clientId: 'client-a' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    }

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRevokeOAuthGrant(), { wrapper: Wrapper });

    await act(async () => {
      result.current.mutate({ clientId: 'client-a' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['oauth-grants'] });
  });
});
