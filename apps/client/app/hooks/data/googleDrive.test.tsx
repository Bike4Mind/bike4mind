import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useLakeDriveConnection } from './googleDrive';

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

  // The route 404s whenever the lake has no organization, i.e. every personal lake. Rejecting there
  // put those lakes into isError, and PurgeDriveWarning then showed its "couldn't check" notice on
  // every ordinary personal-lake purge - about a connection a personal lake cannot even have.
  it('maps a 404 to null rather than an error', async () => {
    get.mockRejectedValue(axiosError(404));

    const { result } = renderLakeDriveConnection('personal_lake');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('still errors on a non-404 failure', async () => {
    get.mockRejectedValue(axiosError(403));

    const { result } = renderLakeDriveConnection('other_org_lake');

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
