import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

const h = vi.hoisted(() => ({
  gitHubFlag: { current: true },
  connection: { current: null as LakeGitHubConnection | null },
  useLakeGitHubConnection: vi.fn(),
}));

// ConnectSourceMenu reads the GitHub flag from the admin settings cache; its items are its own suite's.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub' && h.gitHubFlag.current,
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: (...args: unknown[]) => {
    h.useLakeGitHubConnection(...args);
    return { data: h.connection.current };
  },
}));
vi.mock('@client/app/components/DataLakeWizard/steps/DriveConnectAction', () => ({
  default: () => <div data-testid="drive-connect-action" />,
}));
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubConnectAction', () => ({
  default: () => <div data-testid="github-connect-action" />,
}));

import DataLakeTreeEmptyState from './DataLakeTreeEmptyState';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const gitHubConnection = (over: Partial<LakeGitHubConnection> = {}): LakeGitHubConnection => ({
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
  candidateCount: 10,
  skippedCount: null,
  syncStale: false,
  fileCount: 4,
  disconnecting: false,
  disconnectStalled: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.gitHubFlag.current = true;
  h.connection.current = null;
});

describe('DataLakeTreeEmptyState - connecting a source', () => {
  it('offers Connect a source beside Add files on an empty lake the user can manage', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lake-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
      />
    );

    expect(screen.getByTestId('datalake-tree-empty-addfiles-btn')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-connect-source-btn')).toBeInTheDocument();
  });

  it('offers it on a personal lake too', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lake-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ id: 'lake1', organizationId: null, canManage: true, isCreator: true }}
      />
    );

    expect(screen.getByTestId('datalake-connect-source-btn')).toBeInTheDocument();
  });

  it('offers no source to a user who cannot add files to the lake', () => {
    // The caller withholds onAddFiles from a non-manager; connecting is the same capability.
    wrap(
      <DataLakeTreeEmptyState
        variant="lake-empty"
        sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
      />
    );

    expect(screen.queryByTestId('datalake-connect-source-btn')).toBeNull();
  });

  it('offers no source outside a single scoped empty lake', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lakes-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
      />
    );

    expect(screen.queryByTestId('datalake-connect-source-btn')).toBeNull();
  });

  describe('choosing a source', () => {
    const renderEmptyLake = (onAddFiles: () => void) => {
      wrap(
        <DataLakeTreeEmptyState
          variant="lake-empty"
          onAddFiles={onAddFiles}
          sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
        />
      );
      fireEvent.click(screen.getByTestId('datalake-connect-source-btn'));
    };

    it('opens the GitHub connect panel in a modal, without starting the add-files wizard', () => {
      const onAddFiles = vi.fn();
      renderEmptyLake(onAddFiles);
      expect(screen.queryByTestId('lake-source-connect-modal')).toBeNull();

      fireEvent.click(screen.getByTestId('datalake-connect-source-github-item'));

      const modal = screen.getByTestId('lake-source-connect-modal');
      expect(within(modal).getByTestId('github-connect-action')).toBeInTheDocument();
      expect(onAddFiles).not.toHaveBeenCalled();
    });

    it('routes Google Drive through the add-files wizard and opens no modal', () => {
      const onAddFiles = vi.fn();
      renderEmptyLake(onAddFiles);

      fireEvent.click(screen.getByTestId('datalake-connect-source-drive-item'));

      expect(onAddFiles).toHaveBeenCalledOnce();
      expect(screen.queryByTestId('lake-source-connect-modal')).toBeNull();
    });
  });
});

describe('DataLakeTreeEmptyState - GitHub first sync', () => {
  const orgLake = { id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false };
  const renderEmptyLake = (sourceLake = orgLake) =>
    wrap(<DataLakeTreeEmptyState variant="lake-empty" onAddFiles={vi.fn()} sourceLake={sourceLake} />);

  it('says the repository is syncing, without repeating the source card progress, instead of offering to add files', () => {
    h.connection.current = gitHubConnection();
    renderEmptyLake();

    const empty = screen.getByTestId('datalake-tree-empty');
    expect(empty).toHaveAttribute('data-variant', 'github-syncing');
    expect(screen.getByTestId('datalake-tree-empty-github-syncing')).toHaveTextContent('Syncing acme/docs (main)');
    expect(screen.queryByTestId('github-sync-progress')).toBeNull();
    expect(screen.queryByTestId('datalake-tree-empty-addfiles-btn')).toBeNull();
  });

  it.each([
    ['connected', gitHubConnection({ status: 'connected' })],
    ['stalled', gitHubConnection({ syncStale: true })],
    ['absent', null],
  ])('keeps the normal empty lake view when the connection is %s', (_name, connection) => {
    h.connection.current = connection;
    renderEmptyLake();

    expect(screen.getByTestId('datalake-tree-empty')).toHaveAttribute('data-variant', 'lake-empty');
    expect(screen.getByTestId('datalake-tree-empty-addfiles-btn')).toBeInTheDocument();
  });

  it('watches the connection for a manageable org lake with the flag on', () => {
    renderEmptyLake();
    expect(h.useLakeGitHubConnection).toHaveBeenCalledWith('lake1', true);
  });

  it('does not watch the connection for a lake without an organization', () => {
    h.connection.current = gitHubConnection();
    renderEmptyLake({ ...orgLake, organizationId: null });

    expect(h.useLakeGitHubConnection).toHaveBeenCalledWith('lake1', false);
    expect(screen.getByTestId('datalake-tree-empty')).toHaveAttribute('data-variant', 'lake-empty');
  });

  it('does not watch the connection when the GitHub flag is off', () => {
    h.gitHubFlag.current = false;
    h.connection.current = gitHubConnection();
    renderEmptyLake();

    expect(h.useLakeGitHubConnection).toHaveBeenCalledWith('lake1', false);
    expect(screen.getByTestId('datalake-tree-empty')).toHaveAttribute('data-variant', 'lake-empty');
  });

  it('does not watch the connection for a user who cannot manage the lake', () => {
    renderEmptyLake({ ...orgLake, canManage: false });
    expect(h.useLakeGitHubConnection).toHaveBeenCalledWith('lake1', false);
  });
});
