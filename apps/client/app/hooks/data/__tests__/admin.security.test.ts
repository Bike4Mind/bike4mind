import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet },
}));

import { useGetAllRecentSecurityEvents } from '../admin';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

describe('useGetAllRecentSecurityEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the correct URL with limit=50 and hours=168', async () => {
    mockGet.mockResolvedValue({
      data: {
        items: [],
        since: new Date('2026-03-24T00:00:00Z'),
        user: { email: 'test@example.com', username: 'testuser' },
      },
    });

    const { result } = renderHook(() => useGetAllRecentSecurityEvents(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockGet).toHaveBeenCalledWith('/api/security/user-recent?limit=50&hours=168');
  });

  it('uses the correct query key', async () => {
    mockGet.mockResolvedValue({
      data: {
        items: [],
        since: new Date('2026-03-24T00:00:00Z'),
        user: { email: 'test@example.com', username: 'testuser' },
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    }

    const { result } = renderHook(() => useGetAllRecentSecurityEvents(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cache = queryClient.getQueryCache().findAll({
      queryKey: ['security', 'user', 'recent', '7d'],
    });
    expect(cache).toHaveLength(1);
  });

  it('returns items and since but not user in the result data', async () => {
    const mockItems = [
      {
        type: 'failed_login' as const,
        data: {} as never,
        timestamp: '2026-03-31T10:00:00Z',
      },
    ];
    const mockSince = new Date('2026-03-24T00:00:00Z');

    mockGet.mockResolvedValue({
      data: {
        items: mockItems,
        since: mockSince,
        user: { email: 'admin@example.com', username: 'adminuser' },
      },
    });

    const { result } = renderHook(() => useGetAllRecentSecurityEvents(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveProperty('items', mockItems);
    expect(result.current.data).toHaveProperty('since', mockSince);
    expect(result.current.data).not.toHaveProperty('user');
  });

  it('sets isError when the API request fails', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useGetAllRecentSecurityEvents(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
