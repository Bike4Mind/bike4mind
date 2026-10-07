import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { GitHubLakeRepositoryChoicesResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

// Drives the REAL githubLake hooks through the picker and the lake's source card (only HTTP and the
// store are mocked), with the post-connect connection read left hanging: the picker must close on
// /complete's own response, and the card must show the bound repository from it.
// GitHubRepositoryPickerModal.test.tsx covers the picker's rendering with mocked hooks.

const h = vi.hoisted(() => ({ closePicker: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (
    selector: (s: { gitHubRepoPickerLakeId: string | null; closeGitHubRepoPicker: () => void }) => unknown
  ) => selector({ gitHubRepoPickerLakeId: 'lake1', closeGitHubRepoPicker: h.closePicker }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useUpdateDataLake: () => ({ mutate: vi.fn(), isPending: false }),
  usePromoteDataLake: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/utils/githubLakeConnectHandoff', () => ({ saveGitHubLakeConnectHandoff: vi.fn() }));
vi.mock('@client/app/hooks/useStartChatWithLake', () => ({ default: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import GitHubRepositoryPickerModal from './GitHubRepositoryPickerModal';
import GitHubConnectAction from '../steps/GitHubConnectAction';

const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;

const appTheme = extendTheme({ ...getThemeConfig() });
const CONNECTION_URL = '/api/data-lakes/lake1/github-connection';
const CHOICES_URL = '/api/data-lakes/lake1/github-connection/repositories';
const never = () => new Promise(() => {});

const choices: GitHubLakeRepositoryChoicesResponse = {
  installUrl: 'https://github.com/apps/lake-app/installations/new?state=s1',
  installations: [
    {
      id: 10,
      accountLogin: 'acme',
      accountType: 'Organization',
      settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
      addRepositoriesUrl: 'https://github.com/apps/lake-app/installations/new/permissions?state=s1&target_id=1000',
      violation: null,
      repositories: [{ id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null }],
    },
  ],
};

const bound: LakeGitHubConnection = {
  id: 'c1',
  accountLogin: 'acme',
  repositoryId: 100,
  repositoryFullName: 'acme/docs',
  connectedBy: 'u1',
  connectedAt: '2026-01-01T00:00:00.000Z',
  enabled: true,
  status: 'syncing',
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
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubRepositoryPickerModal - pending state on a successful connect', () => {
  it('closes with its toast on the 201 and the card shows the bound repository, without waiting on the refetch', async () => {
    let connectionReads = 0;
    get.mockImplementation((url: string) => {
      if (url === CHOICES_URL) return Promise.resolve({ data: choices });
      if (url !== CONNECTION_URL) return never();
      connectionReads += 1;
      // Not connected on first load; every read after the connect hangs.
      return connectionReads === 1 ? Promise.resolve({ data: { connection: null } }) : never();
    });
    post.mockResolvedValue({ status: 201, data: { connection: bound } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (ui: ReactNode) => (
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>
      </QueryClientProvider>
    );
    render(
      wrap(
        <>
          <GitHubConnectAction lake={{ id: 'lake1', origin: 'connector-fed' }} />
          <GitHubRepositoryPickerModal />
        </>
      )
    );
    expect(await screen.findByTestId('github-connect-btn')).toBeInTheDocument();
    const confirm = await screen.findByTestId('github-repo-picker-confirm-btn');
    await waitFor(() => expect(confirm).not.toBeDisabled());

    fireEvent.click(confirm);

    await waitFor(() => expect(h.closePicker).toHaveBeenCalled());
    expect(h.toastSuccess).toHaveBeenCalledWith('Connected acme/docs. Its first sync is queued.');
    expect(post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection/complete', {
      installationId: 10,
      repositoryId: 100,
    });
    // The card left "Connect GitHub" for the bound repository while the refetch is still in flight.
    expect(screen.queryByTestId('github-connect-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('github-connection-status')).toHaveTextContent('acme/docs');
    expect(connectionReads).toBeGreaterThan(1);
  });
});
