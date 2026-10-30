import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';

const { getSession, updateUser, navigate, currentUser, activity } = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  navigate: vi.fn(),
  currentUser: { id: 'u1', lastNotebookId: 'gone-session' as string | null },
  activity: { value: null as string | null },
}));

vi.mock('@client/app/utils/sessionsAPICalls', () => ({ getSessionByIdFromServer: getSession }));
vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: updateUser }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/utils/sessionActivityCleanup', () => ({
  getSessionActivity: () => activity.value,
  recordSessionActivity: vi.fn(),
}));
// useGetSession is the only export this hook needs; keep the module's heavy import graph out.
vi.mock('@client/app/hooks/data/sessions', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    useGetSession: (sessionId: string | null) =>
      useQuery({ queryKey: ['sessions', sessionId], enabled: !!sessionId, queryFn: () => getSession(sessionId) }),
  };
});

import { useSessionResumption } from './useSessionResumption';

const notFound = () =>
  new AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const renderResumption = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useSessionResumption({ maxIdleMinutes: 60 }), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
};

describe('useSessionResumption - the last-open session no longer opens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.lastNotebookId = 'gone-session';
    updateUser.mockResolvedValue({});
    getSession.mockRejectedValue(notFound());
  });

  it('starts a new chat and clears the dangling lastNotebookId, fetching the session once', async () => {
    const { result } = renderResumption();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.shouldResume).toBe(false);

    result.current.navigateToSession();
    expect(navigate).toHaveBeenCalledWith({ to: '/new' });

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith('u1', { lastNotebookId: null }));
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('does not navigate into the session even when recent activity said to resume it', async () => {
    activity.value = new Date().toISOString();
    try {
      const { result } = renderResumption();

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      result.current.navigateToSession();
      expect(navigate).toHaveBeenCalledWith({ to: '/new' });
    } finally {
      activity.value = null;
    }
  });

  it('keeps the pointer on a failure that is not a 404', async () => {
    getSession.mockRejectedValue(new Error('network down'));
    const { result } = renderResumption();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.shouldResume).toBe(false);
    expect(updateUser).not.toHaveBeenCalled();
  });
});
