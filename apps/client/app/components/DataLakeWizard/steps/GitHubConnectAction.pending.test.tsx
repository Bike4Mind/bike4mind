import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

// Drives the REAL githubLake hooks through the card's buttons (only HTTP is mocked), with every
// follow-up read left hanging: the buttons must settle on the mutation's own response, not on the
// refetches it triggers. GitHubConnectAction.test.tsx covers the card's rendering with mocked hooks.

const h = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useUpdateDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  usePromoteDataLake: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/utils/githubLakeConnectHandoff', () => ({ saveGitHubLakeConnectHandoff: vi.fn() }));
vi.mock('@client/app/hooks/useStartChatWithLake', () => ({ default: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import GitHubConnectAction from './GitHubConnectAction';

const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

const appTheme = extendTheme({ ...getThemeConfig() });
const CONNECTION_URL = '/api/data-lakes/lake1/github-connection';
const never = () => new Promise(() => {});

const connected: LakeGitHubConnection = {
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
  lastSyncedAt: '2026-01-01T00:05:00.000Z',
  lastSyncedCommitSha: 'abcdef1234567',
  candidateCount: 3,
  skippedCount: 0,
  syncStale: false,
  fileCount: 3,
  disconnecting: false,
  disconnectStalled: false,
};

/** A lake file list that never answers, standing in for a slow refetch the disconnect triggers. */
function HangingLakeFiles() {
  useQuery({ queryKey: dataLakeKeys.files('lake1'), queryFn: never });
  return null;
}

/** The connection read answers once (the card's first load); every later read hangs. */
function renderConnectedCard() {
  let connectionReads = 0;
  get.mockImplementation((url: string) => {
    if (url !== CONNECTION_URL) return never();
    connectionReads += 1;
    return connectionReads === 1 ? Promise.resolve({ data: { connection: connected, canManage: true } }) : never();
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <GitHubConnectAction lake={{ id: 'lake1', origin: 'connector-fed' }} />
        <HangingLakeFiles />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { connectionReads: () => connectionReads };
}

const isLoading = (button: HTMLElement) => button.querySelector('[role="progressbar"]') !== null;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubConnectAction - pending state on a successful response', () => {
  it('clears the disconnect confirmation and shows the disconnecting state on the 202, without waiting on the refetches', async () => {
    const reads = renderConnectedCard();
    fireEvent.click(await screen.findByTestId('github-disconnect-btn'));
    del.mockResolvedValue({ status: 202, data: { success: true, queued: true } });

    fireEvent.click(screen.getByTestId('github-disconnect-confirm-btn'));

    await waitFor(() => expect(screen.queryByTestId('github-disconnect-warning')).not.toBeInTheDocument());
    expect(h.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Disconnecting acme/docs'));
    expect(screen.getByTestId('github-disconnecting-note')).toBeInTheDocument();
    expect(screen.getByTestId('github-disconnect-btn')).toBeDisabled();
    expect(screen.getByTestId('github-disconnect-btn')).toHaveTextContent('Disconnecting');
    // The background refresh was started and is still in flight.
    expect(reads.connectionReads()).toBeGreaterThan(1);
  });

  it('stops the re-sync spinner on the 202, without waiting on the connection refetch', async () => {
    const reads = renderConnectedCard();
    const resync = await screen.findByTestId('github-resync-btn');
    post.mockResolvedValue({ status: 202, data: { connectionId: 'c1', status: 'queued' } });

    fireEvent.click(resync);

    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Re-syncing acme/docs...'));
    expect(isLoading(screen.getByTestId('github-resync-btn'))).toBe(false);
    expect(reads.connectionReads()).toBeGreaterThan(1);
  });
});
