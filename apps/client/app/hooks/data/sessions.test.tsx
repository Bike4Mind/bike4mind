import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, InfiniteData } from '@tanstack/react-query';
import React from 'react';
import {
  useGetSessionQuests,
  useGetOwnSessions,
  getOrFetchSession,
  useSummarizeSession,
  useUpdateSessionTags,
} from './sessions';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { ISessionDocument } from '@bike4mind/common';
// Mocked below (vi.mock is hoisted); imported so the toast assertions can read the spy.
import { toast } from 'sonner';

// Avoid pulling axios + auth wiring into the test - spy on the API calls so we
// can assert "did NOT fetch" cleanly.
vi.mock('@client/app/utils/sessionsAPICalls', async () => {
  const actual = await vi.importActual<object>('@client/app/utils/sessionsAPICalls');
  return {
    ...actual,
    getChatMessages: vi.fn(),
    getSessionsFromServer: vi.fn(),
    getSessionByIdFromServer: vi.fn(),
    generateSessionSummary: vi.fn(),
    generateSessionTags: vi.fn(),
  };
});

// useGetOwnSessions gates on currentUser; provide a stable signed-in user.
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1' } }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('@client/app/hooks/useJobStatus', () => ({
  useJobStatus: () => ({ startJob: vi.fn(), endJob: vi.fn(), isJobRunning: vi.fn(() => false) }),
}));

import {
  getChatMessages,
  getSessionsFromServer,
  getSessionByIdFromServer,
  generateSessionSummary,
  generateSessionTags,
} from '@client/app/utils/sessionsAPICalls';

/**
 * A rejection shaped the way axios actually rejects: `.message` is the generic status line and the
 * server's own reason lives at `response.data.error`. A bare `Error` whose `.message` is already the
 * server text would make the extraction assertion vacuous. See dataLakes.test.ts for the original.
 * `errorCode` is optional because `getInsufficientCreditsMessage` gates strictly on
 * `'insufficient_credits'` - only that value is meant to be extracted.
 */
const axiosRefusal = (status: number, serverMessage: string, errorCode?: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { error: serverMessage, errorCode } },
  });

const renderWithClient = (sessionId: string | null) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const utils = renderHook(() => useGetSessionQuests(sessionId), { wrapper });
  return { ...utils, queryClient };
};

describe('useGetSessionQuests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionLayout({ pendingOptimisticId: null });
  });

  // Regression test. The hook used to remap its queryKey to
  // `['quests', 'session', null]` whenever the id was an optimistic placeholder,
  // which silently detached it from `createOptimisticQuest`'s write site under
  // `['quests', 'session', <tmpId>]`. That's how a send-error reply ended up in
  // cache but never rendered in the chat.
  it('reads optimistic data written under the same tmpId and does not fetch', async () => {
    const tmpId = 'optimistic-session-abc-123';
    const optimisticPage = {
      data: [
        {
          id: 'optimistic-quest-' + tmpId,
          sessionId: tmpId,
          prompt: 'hello world',
          replies: ['**Error:** Request blocked by CDN (CloudFront, status 403)…'],
          status: 'done',
        },
      ],
      hasMore: false,
    };

    const { result, queryClient } = renderWithClient(tmpId);
    queryClient.setQueryData(['quests', 'session', tmpId], {
      pages: [optimisticPage],
      pageParams: [{ page: 1 }],
    });

    await waitFor(() => {
      expect(result.current.data?.pages[0]?.data[0]?.prompt).toBe('hello world');
    });
    expect(result.current.data?.pages[0]?.data[0]?.replies?.[0]).toMatch(/Error:/);
    expect(getChatMessages).not.toHaveBeenCalled();
  });

  it('does not fetch when sessionId matches the pending optimistic id', async () => {
    const tmpId = 'optimistic-session-xyz-789';
    setSessionLayout({ pendingOptimisticId: tmpId });

    renderWithClient(tmpId);

    // No waitFor - query is disabled, so there's nothing to wait on; an
    // immediate assertion is enough.
    expect(getChatMessages).not.toHaveBeenCalled();
  });

  it('fetches for a real (non-optimistic) sessionId', async () => {
    const realId = '507f1f77bcf86cd799439011';
    vi.mocked(getChatMessages).mockResolvedValue({ data: [], hasMore: false });

    renderWithClient(realId);

    await waitFor(() => {
      expect(getChatMessages).toHaveBeenCalledWith(
        realId,
        expect.objectContaining({ pagination: { page: 1, limit: 10 }, sort: 'desc' })
      );
    });
  });

  it('does not fetch when sessionId is null', () => {
    renderWithClient(null);
    expect(getChatMessages).not.toHaveBeenCalled();
  });
});

// The cold-load double-fetch was caused by a removeQueries() effect that
// evicted the in-flight query on mount. The fix moves the "trim to page 1 on
// remount" concern into useGetOwnSessions' refetchOnMount (returning false so it
// never triggers a refetch). These guard that behavior.
type SessionsPage = { data: ISessionDocument[]; hasMore: boolean };
const OWN_KEY = ['sessions', 'own', '', ''];

const makePage = (id: string, hasMore: boolean): SessionsPage => ({ data: [{ id } as ISessionDocument], hasMore });

const renderOwnWith = (seed?: InfiniteData<SessionsPage>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) queryClient.setQueryData(OWN_KEY, seed);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const utils = renderHook(() => useGetOwnSessions(''), { wrapper });
  return { ...utils, queryClient };
};

describe('useGetOwnSessions refetchOnMount trim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionsFromServer).mockResolvedValue({ data: [], hasMore: false });
  });

  it('trims cached pages to page 1 on mount and does NOT refetch', async () => {
    const { queryClient } = renderOwnWith({
      pages: [makePage('s1', true), makePage('s2', false)],
      pageParams: [{ page: 1 }, { page: 2 }],
    });

    await waitFor(() => {
      const data = queryClient.getQueryData<InfiniteData<SessionsPage>>(OWN_KEY);
      expect(data?.pages).toHaveLength(1);
    });
    expect(queryClient.getQueryData<InfiniteData<SessionsPage>>(OWN_KEY)?.pageParams).toEqual([{ page: 1 }]);
    // The whole point: no second fetch is triggered on (re)mount.
    expect(getSessionsFromServer).not.toHaveBeenCalled();
  });

  it('still performs the initial cold fetch exactly once when there is no cached data', async () => {
    renderOwnWith();

    await waitFor(() => {
      expect(getSessionsFromServer).toHaveBeenCalledTimes(1);
    });
    // refetchOnMount only governs refetch of EXISTING data - the cold fetch runs once.
    expect(getSessionsFromServer).toHaveBeenCalledTimes(1);
  });
});

// Regression test. After sending the first message on /new, a race
// between context propagation and the navigation to /notebooks/<tmpId> could
// cause SessionContainer to invoke `changeSession` (-> getOrFetchSession) with
// the optimistic tmpId. That used to hit GET /api/sessions/optimistic-session-...
// and 404. The fix keeps optimistic IDs entirely client-side.
describe('getOrFetchSession optimistic-id guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached synthetic session without hitting the server', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tmpId = 'optimistic-session-abc-123';
    const synthetic = { id: tmpId, name: 'New Notebook' } as ISessionDocument;
    queryClient.setQueryData(['sessions', tmpId], synthetic);

    const result = await getOrFetchSession(queryClient, tmpId);

    expect(result).toBe(synthetic);
    expect(getSessionByIdFromServer).not.toHaveBeenCalled();
  });

  it('throws (does NOT fetch) when an optimistic id has no cache entry', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await expect(getOrFetchSession(queryClient, 'optimistic-session-missing')).rejects.toThrow(
      /No cached session for optimistic id/
    );
    expect(getSessionByIdFromServer).not.toHaveBeenCalled();
  });
});

const SESSION_ID = 'session-1';
const SESSION_NAME = 'Q3 planning';

const renderMutationWithSeededSession = <T,>(useHook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(['sessions', SESSION_ID], { id: SESSION_ID, name: SESSION_NAME } as ISessionDocument);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(useHook, { wrapper });
};

// Regression tests. The success toast used to fire from inside mutationFn - i.e. optimistically,
// on click, before the request was even accepted. A credit-refused request would then show
// "Started summarizing ..." and immediately contradict itself with the refusal. It now fires only
// from onSuccess, once the request is actually accepted.
describe('useSummarizeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts success only after the request is accepted', async () => {
    vi.mocked(generateSessionSummary).mockResolvedValueOnce({ status: 'started' });
    const { result } = renderMutationWithSeededSession(() => useSummarizeSession());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith(`Started summarizing "${SESSION_NAME}"`);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('never toasts success on a rejected mutation', async () => {
    vi.mocked(generateSessionSummary).mockRejectedValueOnce(axiosRefusal(500, 'Internal error'));
    const { result } = renderMutationWithSeededSession(() => useSummarizeSession());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('surfaces the server credit message on a 422 insufficient-credits refusal', async () => {
    const serverMessage = 'You need 50 more credits to summarize this session';
    vi.mocked(generateSessionSummary).mockRejectedValueOnce(axiosRefusal(422, serverMessage, 'insufficient_credits'));
    const { result } = renderMutationWithSeededSession(() => useSummarizeSession());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith(serverMessage);
  });

  it('falls back to the generic failure message for an unrelated rejection', async () => {
    vi.mocked(generateSessionSummary).mockRejectedValueOnce(axiosRefusal(500, 'Internal error'));
    const { result } = renderMutationWithSeededSession(() => useSummarizeSession());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith(`Failed to start summarizing "${SESSION_NAME}"`);
  });
});

// Same regression coverage as useSummarizeSession, for the tags mutation.
describe('useUpdateSessionTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts success only after the request is accepted', async () => {
    vi.mocked(generateSessionTags).mockResolvedValueOnce({ status: 'started' });
    const { result } = renderMutationWithSeededSession(() => useUpdateSessionTags());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith(`Started generating tags for "${SESSION_NAME}"`);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('never toasts success on a rejected mutation', async () => {
    vi.mocked(generateSessionTags).mockRejectedValueOnce(axiosRefusal(500, 'Internal error'));
    const { result } = renderMutationWithSeededSession(() => useUpdateSessionTags());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('surfaces the server credit message on a 422 insufficient-credits refusal', async () => {
    const serverMessage = 'You need 50 more credits to generate tags for this session';
    vi.mocked(generateSessionTags).mockRejectedValueOnce(axiosRefusal(422, serverMessage, 'insufficient_credits'));
    const { result } = renderMutationWithSeededSession(() => useUpdateSessionTags());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith(serverMessage);
  });

  it('falls back to the generic failure message for an unrelated rejection', async () => {
    vi.mocked(generateSessionTags).mockRejectedValueOnce(axiosRefusal(500, 'Internal error'));
    const { result } = renderMutationWithSeededSession(() => useUpdateSessionTags());

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith(`Failed to start generating tags for "${SESSION_NAME}"`);
  });
});
