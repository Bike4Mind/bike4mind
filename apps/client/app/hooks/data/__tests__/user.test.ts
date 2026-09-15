import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockUpdateUserToServer } = vi.hoisted(() => ({
  mockUpdateUserToServer: vi.fn(),
}));

vi.mock('@client/app/utils/userAPICalls', () => ({
  updateUserToServer: mockUpdateUserToServer,
  fetchUsers: vi.fn(),
  fetchUserTags: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useUpdateUser } from '../user';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return { Wrapper, queryClient };
}

describe('useUpdateUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates the identify query on success so the sidebar switcher refreshes', async () => {
    const freshUser = { id: 'user-1', name: 'New Name' };
    mockUpdateUserToServer.mockResolvedValue(freshUser);

    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateUser(), { wrapper: Wrapper });

    result.current.mutate({ id: 'user-1', data: { name: 'New Name' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const invalidatedKeys = invalidateSpy.mock.calls.map(call => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['identify']);
    // Existing invalidations must remain intact.
    expect(invalidatedKeys).toContainEqual(['users']);
    expect(invalidatedKeys).toContainEqual(['sessions']);
    expect(invalidatedKeys).toContainEqual(['organizations']);
  });

  it('writes the fresh user into the users cache on success', async () => {
    const freshUser = { id: 'user-1', name: 'New Name' };
    mockUpdateUserToServer.mockResolvedValue(freshUser);

    const { Wrapper, queryClient } = createWrapper();

    const { result } = renderHook(() => useUpdateUser(), { wrapper: Wrapper });

    result.current.mutate({ id: 'user-1', data: { name: 'New Name' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(['users', 'user-1'])).toEqual(freshUser);
  });
});
