import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import {
  useLakeDriveConnection,
  useLakeDriveCanManage,
  useDisconnectLakeDrive,
  driveConnectionPollInterval,
  startGoogleDriveConnect,
  DRIVE_CONNECTION_ACTIVE_POLL_MS,
  DRIVE_CONNECTION_IDLE_POLL_MS,
  type LakeDriveConnection,
} from './googleDrive';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const get = api.get as unknown as Mock;
const del = api.delete as unknown as Mock;
const post = api.post as unknown as Mock;

const renderLakeDriveConnection = (lakeId: string) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useLakeDriveConnection(lakeId), { wrapper });
};

const axiosError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });

describe('startGoogleDriveConnect', () => {
  it('sends the browser to the consent URL the connect route returns', async () => {
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
    post.mockResolvedValue({ data: { authUrl: 'https://accounts.google.com/o/oauth2/auth?x=1' } });

    try {
      await startGoogleDriveConnect();
      expect(post).toHaveBeenCalledWith('/api/google-drive/connect');
      expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });
});

describe('useLakeDriveConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the connection on a 200', async () => {
    const connection = { id: 'c1', driveFolderId: 'fld_1', folderName: 'Q3-Reports', status: 'connected' };
    get.mockResolvedValue({ data: { connection } });

    const { result } = renderLakeDriveConnection('lake_1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(connection);
  });

  // A personal lake has no organization to hold a connection, so the route resolves 200 with a
  // null connection rather than 404 - the server tells "no connection" apart from "can't tell",
  // so PurgeDriveWarning doesn't show its "couldn't check" notice on an ordinary personal-lake
  // purge, about a connection a personal lake cannot even have.
  it('treats a 200 with a null connection as success, not an error', async () => {
    get.mockResolvedValue({ data: { connection: null } });

    const { result } = renderLakeDriveConnection('personal_lake');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('errors on a genuine failure (lake not found, or caller lacks org access)', async () => {
    get.mockRejectedValue(axiosError(404));

    const { result } = renderLakeDriveConnection('other_org_lake');

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('refreshes the lake file queries once the background disconnect purge releases the connection', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    get.mockResolvedValueOnce({ data: { connection: { id: 'c1', disconnecting: true, fileCount: 3 } } });
    const { result } = renderHook(() => useLakeDriveConnection('lake_1'), { wrapper });
    await waitFor(() => expect(result.current.data).toMatchObject({ disconnecting: true }));
    expect(invalidateSpy).not.toHaveBeenCalled();

    get.mockResolvedValueOnce({ data: { connection: null } });
    await act(async () => {
      await result.current.refetch();
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.filesOf('lake_1'));
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.tagCountsRoot);
  });
});

// The DELETE route purges every FabFile the connection ingested (see drive-connection.ts) - a
// disconnect used to delete nothing, so before this fix the mutation only invalidated the
// connection-status query, leaving the lake's own file list/counts stale until a full reload.
// The query data is { connection, canManage } while consumers read only the connection, so the poll
// cadence has to key off `data.connection` - reading the wrapper would silently stop polling.
describe('useLakeDriveConnection polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps polling an existing connection at the idle cadence', async () => {
    get.mockResolvedValue({
      data: { connection: { id: 'c1', status: 'connected', syncStale: false, disconnecting: false, fileCount: 1 } },
    });
    renderLakeDriveConnection('lake_1');

    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DRIVE_CONNECTION_IDLE_POLL_MS);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not poll when the lake has no connection', async () => {
    get.mockResolvedValue({ data: { connection: null, canManage: false } });
    renderLakeDriveConnection('lake_1');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DRIVE_CONNECTION_IDLE_POLL_MS * 3);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('useLakeDriveCanManage', () => {
  beforeEach(() => vi.clearAllMocks());

  const renderBoth = (lakeId: string) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(
      () => ({ connection: useLakeDriveConnection(lakeId), canManage: useLakeDriveCanManage(lakeId) }),
      {
        wrapper,
      }
    );
  };

  it('reads false for an appointed admin, and shares one request with the connection hook', async () => {
    get.mockResolvedValue({ data: { connection: { id: 'conn1' }, canManage: false } });
    const { result } = renderBoth('lake1');

    await waitFor(() => expect(result.current.canManage.data).toBe(false));
    expect(result.current.connection.data).toEqual({ id: 'conn1' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads true for a manager, and when the payload carries no flag', async () => {
    get.mockResolvedValue({ data: { connection: null, canManage: true } });
    const { result, unmount } = renderBoth('lake1');
    await waitFor(() => expect(result.current.canManage.data).toBe(true));
    unmount();

    get.mockResolvedValue({ data: { connection: null } });
    const second = renderBoth('lake2');
    await waitFor(() => expect(second.result.current.canManage.data).toBe(true));
  });
});

describe('useDisconnectLakeDrive', () => {
  it('invalidates the lake file list and tag counts alongside the connection status', async () => {
    del.mockResolvedValue({ data: undefined });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDisconnectLakeDrive(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('lake_1');
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(['lake-drive-connection', 'lake_1']);
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.filesOf('lake_1'));
    expect(invalidatedKeys).toContainEqual(dataLakeKeys.tagCountsRoot);
  });
});

// A fresh connect writes status:'connected' immediately, before the queued ingest job claims it
// into 'syncing' - a poll that only ran while 'syncing' would never re-fetch past that pre-claim
// gap and could cache fileCount: 0 forever.
describe('driveConnectionPollInterval', () => {
  const connection = (overrides: Partial<LakeDriveConnection>): LakeDriveConnection => ({
    id: 'c1',
    driveFolderId: 'fld_1',
    folderName: 'Q3-Reports',
    status: 'connected',
    syncStale: false,
    enabled: true,
    lastError: null,
    lastUsedAt: null,
    connectedAt: null,
    fileCount: 0,
    disconnecting: false,
    disconnectStalled: false,
    ...overrides,
  });

  it('does not poll when there is no connection', () => {
    expect(driveConnectionPollInterval(null)).toBe(false);
    expect(driveConnectionPollInterval(undefined)).toBe(false);
  });

  it('polls fast while a sync is actively in flight', () => {
    expect(driveConnectionPollInterval(connection({ status: 'syncing' }))).toBe(DRIVE_CONNECTION_ACTIVE_POLL_MS);
  });

  it('drops to the idle cadence for a stalled sync, which will not change until someone clicks Re-sync', () => {
    expect(driveConnectionPollInterval(connection({ status: 'syncing', syncStale: true }))).toBe(
      DRIVE_CONNECTION_IDLE_POLL_MS
    );
  });

  it('keeps the active cadence for a stalled sync that is also disconnecting', () => {
    expect(driveConnectionPollInterval(connection({ status: 'syncing', syncStale: true, disconnecting: true }))).toBe(
      DRIVE_CONNECTION_ACTIVE_POLL_MS
    );
  });

  it('polls fast while a queued disconnect purge is running, so the connection clears promptly', () => {
    expect(driveConnectionPollInterval(connection({ disconnecting: true }))).toBe(DRIVE_CONNECTION_ACTIVE_POLL_MS);
  });

  it('keeps polling at an idle cadence once connected, so a pre-claim fileCount eventually settles', () => {
    expect(driveConnectionPollInterval(connection({ status: 'connected', fileCount: 0 }))).toBe(
      DRIVE_CONNECTION_IDLE_POLL_MS
    );
  });
});
