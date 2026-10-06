import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import {
  useLakeGitHubConnection,
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

describe('useStartLakeGitHubConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs to mint the authorize url', async () => {
    const urls = { authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=c&state=s1' };
    post.mockResolvedValue({ data: urls });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStartLakeGitHubConnect(), { wrapper: wrapperFor(queryClient) });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync('lake1');
    });

    expect(post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection');
    expect(response).toEqual(urls);
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
});

describe('useDisconnectLakeGitHub', () => {
  beforeEach(() => vi.clearAllMocks());

  it('DELETEs the connection and invalidates the connection, the lake files, and tag counts', async () => {
    del.mockResolvedValue({ data: undefined });
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
});
