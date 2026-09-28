import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  useLakeDriveConnection,
  driveConnectionPollInterval,
  DRIVE_CONNECTION_ACTIVE_POLL_MS,
  DRIVE_CONNECTION_IDLE_POLL_MS,
  type LakeDriveConnection,
} from './googleDrive';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const get = api.get as unknown as Mock;

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
    enabled: true,
    lastError: null,
    lastUsedAt: null,
    connectedAt: null,
    fileCount: 0,
    ...overrides,
  });

  it('does not poll when there is no connection', () => {
    expect(driveConnectionPollInterval(null)).toBe(false);
    expect(driveConnectionPollInterval(undefined)).toBe(false);
  });

  it('polls fast while a sync is actively in flight', () => {
    expect(driveConnectionPollInterval(connection({ status: 'syncing' }))).toBe(DRIVE_CONNECTION_ACTIVE_POLL_MS);
  });

  it('keeps polling at an idle cadence once connected, so a pre-claim fileCount eventually settles', () => {
    expect(driveConnectionPollInterval(connection({ status: 'connected', fileCount: 0 }))).toBe(
      DRIVE_CONNECTION_IDLE_POLL_MS
    );
  });
});
