import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import {
  useLakeGitHubConnection,
  useLakeGitHubCanManage,
  useStartLakeGitHubConnect,
  useAuthorizeLakeGitHubConnect,
  useLakeGitHubRepositoryChoices,
  useCompleteLakeGitHubConnect,
  useResyncLakeGitHub,
  useDisconnectLakeGitHub,
  gitHubConnectionPollInterval,
  GITHUB_CONNECTION_ACTIVE_POLL_MS,
  GITHUB_CONNECTION_IDLE_POLL_MS,
  type LakeGitHubConnection,
} from './githubLake';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

const wrapperFor = (queryClient: QueryClient) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

const axiosError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });

const renderLakeGitHubConnection = (dataLakeId?: string, enabled = true) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useLakeGitHubConnection(dataLakeId, enabled), { wrapper: wrapperFor(queryClient) });
};

describe('gitHubConnectionPollInterval', () => {
  const connection = (overrides: Partial<LakeGitHubConnection> = {}): LakeGitHubConnection => ({
    id: 'c1',
    accountLogin: 'acme',
    repositoryId: 100,
    repositoryFullName: 'acme/docs',
    connectedBy: 'u1',
    connectedAt: '2026-01-01T00:00:00.000Z',
    enabled: true,
    status: 'connected',
    lastError: null,
    defaultBranch: 'main',
    lastSyncedAt: null,
    lastSyncedCommitSha: null,
    candidateCount: null,
    skippedCount: null,
    syncStale: false,
    fileCount: 0,
    disconnecting: false,
    disconnectStalled: false,
    ...overrides,
  });

  it('does not poll when there is no connection', () => {
    expect(gitHubConnectionPollInterval(null)).toBe(false);
    expect(gitHubConnectionPollInterval(undefined)).toBe(false);
  });

  it('polls fast while a sync is actively in flight', () => {
    expect(gitHubConnectionPollInterval(connection({ status: 'syncing' }))).toBe(GITHUB_CONNECTION_ACTIVE_POLL_MS);
  });

  it('polls at an idle cadence once a syncing claim has gone stale, since nothing is actively running', () => {
    expect(gitHubConnectionPollInterval(connection({ status: 'syncing', syncStale: true }))).toBe(
      GITHUB_CONNECTION_IDLE_POLL_MS
    );
  });

  it('polls at an idle cadence once connected', () => {
    expect(gitHubConnectionPollInterval(connection({ status: 'connected' }))).toBe(GITHUB_CONNECTION_IDLE_POLL_MS);
  });

  it('polls at an idle cadence on error, since a stalled sync is not actively in flight', () => {
    expect(gitHubConnectionPollInterval(connection({ status: 'error' }))).toBe(GITHUB_CONNECTION_IDLE_POLL_MS);
  });

  it('polls fast while a disconnect is pending, even though the connection reads as connected', () => {
    expect(gitHubConnectionPollInterval(connection({ status: 'connected', disconnecting: true }))).toBe(
      GITHUB_CONNECTION_ACTIVE_POLL_MS
    );
  });
});

describe('useLakeGitHubConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs the lake connection and returns it', async () => {
    const connection = { id: 'c1', repositoryFullName: 'acme/docs', status: 'connected' };
    get.mockResolvedValue({ data: { connection } });

    const { result } = renderLakeGitHubConnection('lake1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection');
    expect(result.current.data).toEqual(connection);
  });

  it('errors on a genuine failure (lake not found, or caller lacks org access)', async () => {
    get.mockRejectedValue(axiosError(404));

    const { result } = renderLakeGitHubConnection('other_org_lake');

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it.each([
    ['the ingested file count changes mid-sync', { status: 'syncing', fileCount: 39 }],
    ['a sync finishes with the same file count', { status: 'connected', fileCount: 0 }],
  ])('refreshes the lake file queries when %s', async (_case, nextFields) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    get.mockResolvedValueOnce({ data: { connection: { id: 'c1', status: 'syncing', fileCount: 0 } } });
    const { result } = renderHook(() => useLakeGitHubConnection('lake1'), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();

    get.mockResolvedValueOnce({ data: { connection: { id: 'c1', ...nextFields } } });
    await act(async () => {
      await result.current.refetch();
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.filesOf('lake1'));
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.tagCountsRoot);
  });

  it('leaves the lake file queries alone on an idle poll that changed nothing', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    get.mockResolvedValue({ data: { connection: { id: 'c1', status: 'connected', fileCount: 135 } } });
    const { result } = renderHook(() => useLakeGitHubConnection('lake1'), { wrapper: wrapperFor(queryClient) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => {
      await result.current.refetch();
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not fetch when disabled', () => {
    renderLakeGitHubConnection('lake1', false);
    expect(get).not.toHaveBeenCalled();
  });

  it('does not fetch without a lake id', () => {
    renderLakeGitHubConnection(undefined);
    expect(get).not.toHaveBeenCalled();
  });
});

// The query data is { connection, canManage } while consumers read only the connection, so the poll
// cadence has to key off `data.connection` - reading the wrapper would silently stop polling.
describe('useLakeGitHubConnection polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps polling an existing connection at the idle cadence', async () => {
    get.mockResolvedValue({
      data: { connection: { id: 'c1', status: 'connected', syncStale: false, disconnecting: false, fileCount: 1 } },
    });
    renderLakeGitHubConnection('lake1');

    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_CONNECTION_IDLE_POLL_MS);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not poll when the lake has no connection', async () => {
    get.mockResolvedValue({ data: { connection: null, canManage: false } });
    renderLakeGitHubConnection('lake1');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(GITHUB_CONNECTION_IDLE_POLL_MS * 3);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('useLakeGitHubCanManage', () => {
  beforeEach(() => vi.clearAllMocks());

  const renderBoth = (dataLakeId: string) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderHook(
      () => ({ connection: useLakeGitHubConnection(dataLakeId), canManage: useLakeGitHubCanManage(dataLakeId) }),
      { wrapper: wrapperFor(queryClient) }
    );
  };

  it('reads false for an appointed admin, and shares one request with the connection hook', async () => {
    get.mockResolvedValue({ data: { connection: { id: 'conn1' }, canManage: false } });
    const { result } = renderBoth('lake1');

    await waitFor(() => expect(result.current.canManage.data).toBe(false));
    expect(result.current.connection.data).toEqual({ id: 'conn1' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads true for a manager', async () => {
    get.mockResolvedValue({ data: { connection: null, canManage: true } });
    const { result } = renderBoth('lake1');
    await waitFor(() => expect(result.current.canManage.data).toBe(true));
  });

  it('fails closed (false) when the payload carries no flag', async () => {
    get.mockResolvedValue({ data: { connection: null } });
    const { result } = renderBoth('lake2');
    await waitFor(() => expect(result.current.canManage.data).toBe(false));
  });
});

describe('useStartLakeGitHubConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs to mint the authorize url', async () => {
    const urls = { authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=c&state=s1' };
    post.mockResolvedValue({ data: urls });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStartLakeGitHubConnect(), { wrapper: wrapperFor(queryClient) });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({ dataLakeId: 'lake1' });
    });

    expect(post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection');
    expect(response).toEqual(urls);
  });

  it('asks the server to switch the origin, then refetches the lake list and its config history', async () => {
    post.mockResolvedValue({ data: { authorizeUrl: 'https://github.com/login/oauth/authorize?state=s1' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useStartLakeGitHubConnect(), { wrapper: wrapperFor(queryClient) });

    await act(async () => {
      await result.current.mutateAsync({ dataLakeId: 'lake1', ensureConnectorFed: true });
    });

    expect(post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection', { ensureConnectorFed: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dataLakeKeys.list });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dataLakeKeys.configHistoryOf('lake1') });
  });
});

describe('useAuthorizeLakeGitHubConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchanges the code and state for the lake id the flow is bound to', async () => {
    post.mockResolvedValue({ data: { dataLakeId: 'lake1' } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useAuthorizeLakeGitHubConnect(), { wrapper: wrapperFor(queryClient) });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({ state: 's1', code: 'c1' });
    });

    expect(post).toHaveBeenCalledWith('/api/data-lakes/github-callback', { state: 's1', code: 'c1' });
    expect(response).toEqual({ dataLakeId: 'lake1' });
  });
});

describe('useLakeGitHubRepositoryChoices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs the repository picker list for the lake', async () => {
    const choices = { installations: [], installUrl: 'https://github.com/apps/lake-app/installations/new?state=s1' };
    get.mockResolvedValue({ data: choices });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLakeGitHubRepositoryChoices('lake1', true), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection/repositories');
    expect(result.current.data).toEqual(choices);
  });

  it('does not fetch while disabled (the picker is closed)', () => {
    renderHook(() => useLakeGitHubRepositoryChoices('lake1', false), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('does not fetch without a lake id', () => {
    renderHook(() => useLakeGitHubRepositoryChoices(undefined, true), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('never retries: a failure here is the flow having expired, which a retry cannot fix', async () => {
    get.mockRejectedValue(axiosError(403));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLakeGitHubRepositoryChoices('lake1', true), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('useCompleteLakeGitHubConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts the pick, returns the bound connection, invalidates the connection, and drops the stale picker list', async () => {
    const connection = { id: 'c1', repositoryFullName: 'acme/docs' };
    post.mockResolvedValue({ data: { connection } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');
    const { result } = renderHook(() => useCompleteLakeGitHubConnect(), { wrapper: wrapperFor(queryClient) });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({ dataLakeId: 'lake1', installationId: 42, repositoryId: 100 });
    });

    expect(post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection/complete', {
      installationId: 42,
      repositoryId: 100,
    });
    expect(response).toEqual(connection);

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.gitHubConnection('lake1'));
    const removedKeys = removeSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(removedKeys).toContainEqual(dataLakeKeys.gitHubRepositoryChoices('lake1'));
    expect(queryClient.getQueryData(dataLakeKeys.gitHubConnection('lake1'))).toEqual({ connection, canManage: true });
  });

  it('settles as soon as the POST does, without waiting on the connection refetch', async () => {
    const connection = { id: 'c1', repositoryFullName: 'acme/docs' };
    post.mockResolvedValue({ data: { connection } });
    get.mockReturnValue(new Promise(() => {}));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => ({ connection: useLakeGitHubConnection('lake1'), complete: useCompleteLakeGitHubConnect() }),
      { wrapper: wrapperFor(queryClient) }
    );

    act(() => result.current.complete.mutate({ dataLakeId: 'lake1', installationId: 42, repositoryId: 100 }));

    await waitFor(() => expect(result.current.complete.isSuccess).toBe(true));
    expect(result.current.connection.isFetching).toBe(true);
    expect(result.current.connection.data).toEqual(connection);
  });
});

describe('useResyncLakeGitHub', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs a re-sync and invalidates that lake connection', async () => {
    post.mockResolvedValue({ data: undefined });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useResyncLakeGitHub(), { wrapper: wrapperFor(queryClient) });

    await act(async () => {
      await result.current.mutateAsync('lake1');
    });

    expect(post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection/sync');
    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.gitHubConnection('lake1'));
  });

  it('settles as soon as the POST does, without waiting on the connection refetch', async () => {
    post.mockResolvedValue({ data: undefined });
    get.mockReturnValue(new Promise(() => {}));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => ({ connection: useLakeGitHubConnection('lake1'), resync: useResyncLakeGitHub() }),
      { wrapper: wrapperFor(queryClient) }
    );

    act(() => result.current.resync.mutate('lake1'));

    await waitFor(() => expect(result.current.resync.isSuccess).toBe(true));
    expect(result.current.connection.isFetching).toBe(true);
  });
});

describe('useDisconnectLakeGitHub', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DELETEs the connection and invalidates the connection, the lake files, and tag counts', async () => {
    del.mockResolvedValue({ status: 202, data: { success: true, queued: true } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDisconnectLakeGitHub(), { wrapper: wrapperFor(queryClient) });

    await act(async () => {
      await result.current.mutateAsync('lake1');
    });

    expect(del).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection');
    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.gitHubConnection('lake1'));
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.filesOf('lake1'));
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.tagCountsRoot);
  });

  const connected = { id: 'c1', repositoryFullName: 'acme/docs', disconnecting: false, disconnectStalled: true };

  it('settles on the 202 without waiting on the refetches, and shows the connection as disconnecting', async () => {
    del.mockResolvedValue({ status: 202, data: { success: true, queued: true } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    get.mockResolvedValueOnce({ data: { connection: connected } });
    const { result } = renderHook(
      () => ({
        connection: useLakeGitHubConnection('lake1'),
        files: useQuery({ queryKey: dataLakeKeys.files('lake1'), queryFn: () => new Promise(() => {}) }),
        disconnect: useDisconnectLakeGitHub(),
      }),
      { wrapper: wrapperFor(queryClient) }
    );
    await waitFor(() => expect(result.current.connection.data).toEqual(connected));
    get.mockReturnValue(new Promise(() => {}));

    act(() => result.current.disconnect.mutate('lake1'));

    await waitFor(() => expect(result.current.disconnect.isSuccess).toBe(true));
    expect(result.current.connection.isFetching).toBe(true);
    expect(result.current.connection.data).toEqual({ ...connected, disconnecting: true, disconnectStalled: false });
  });

  it('still shows a repeat disconnect as disconnecting when its 202 says no new purge was queued', async () => {
    del.mockResolvedValue({ status: 202, data: { success: true, queued: false } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(dataLakeKeys.gitHubConnection('lake1'), {
      connection: { ...connected, disconnecting: true },
      canManage: true,
    });
    const { result } = renderHook(() => useDisconnectLakeGitHub(), { wrapper: wrapperFor(queryClient) });

    await act(async () => {
      await result.current.mutateAsync('lake1');
    });

    expect(queryClient.getQueryData(dataLakeKeys.gitHubConnection('lake1'))).toEqual({
      connection: { ...connected, disconnecting: true, disconnectStalled: false },
      canManage: true,
    });
  });

  it('clears the cached connection on a 204 (nothing was connected)', async () => {
    del.mockResolvedValue({ status: 204, data: '' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(dataLakeKeys.gitHubConnection('lake1'), { connection: connected, canManage: true });
    const { result } = renderHook(() => useDisconnectLakeGitHub(), { wrapper: wrapperFor(queryClient) });

    await act(async () => {
      await result.current.mutateAsync('lake1');
    });

    expect(queryClient.getQueryData(dataLakeKeys.gitHubConnection('lake1'))).toEqual({
      connection: null,
      canManage: true,
    });
  });
});
