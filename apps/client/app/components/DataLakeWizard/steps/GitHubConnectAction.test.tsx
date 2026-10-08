import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

const h = vi.hoisted(() => ({
  connection: { current: null as LakeGitHubConnection | null },
  isError: { current: false },
  canManage: { current: true },
  startMutateAsync: vi.fn(),
  startPending: { current: false },
  resyncMutate: vi.fn(),
  disconnectMutate: vi.fn(),
  saveHandoff: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  startChatWithLake: vi.fn(),
  promoteMutateAsync: vi.fn(),
}));

vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: () => ({ data: h.connection.current, isLoading: false, isError: h.isError.current }),
  useLakeGitHubCanManage: () => ({ data: h.canManage.current }),
  useStartLakeGitHubConnect: () => ({ mutateAsync: h.startMutateAsync, isPending: h.startPending.current }),
  useResyncLakeGitHub: () => ({ mutate: h.resyncMutate, isPending: false }),
  useDisconnectLakeGitHub: () => ({ mutate: h.disconnectMutate, isPending: false }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  usePromoteDataLake: () => ({ mutateAsync: h.promoteMutateAsync, isPending: false }),
}));
vi.mock('@client/app/utils/githubLakeConnectHandoff', () => ({ saveGitHubLakeConnectHandoff: h.saveHandoff }));
vi.mock('@client/app/hooks/useStartChatWithLake', () => ({ default: () => h.startChatWithLake }));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import GitHubConnectAction from './GitHubConnectAction';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const connected = (over: Partial<LakeGitHubConnection> = {}): LakeGitHubConnection => ({
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
  fileCount: 3,
  disconnecting: false,
  disconnectStalled: false,
  ...over,
});

const FED_LAKE = { id: 'lake1', origin: 'connector-fed' as const };

const URLS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=c&state=s1',
};

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.connection.current = null;
  h.isError.current = false;
  h.canManage.current = true;
  h.startPending.current = false;
  h.startMutateAsync.mockResolvedValue(URLS);
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Click, then let the awaited start settle (it resolves with URLS unless a test says otherwise). */
const clickAndSettle = async (testId: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
};

describe('GitHubConnectAction', () => {
  it('offers Connect GitHub, with its read-only disclosure, when the lake has no repository', () => {
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connect-btn')).not.toBeDisabled();
    expect(screen.getByTestId('github-access-disclosure')).toHaveTextContent(/approve the GitHub App/);
  });

  it('saves the handoff for the callback page, then sends the browser to the authorize page', async () => {
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    await clickAndSettle('github-connect-btn');
    expect(h.startMutateAsync).toHaveBeenCalledWith({ dataLakeId: 'lake1', ensureConnectorFed: undefined });
    expect(h.saveHandoff).toHaveBeenCalledWith({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(URLS.authorizeUrl);
  });

  it('does not leave for GitHub when the handoff cannot be saved, since the callback could not finish', async () => {
    h.saveHandoff.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    await clickAndSettle('github-connect-btn');

    expect(assign).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/session storage/));
  });

  it("surfaces the server's reason when the connect cannot start", async () => {
    h.startMutateAsync.mockRejectedValue({ isAxiosError: true, response: { data: { error: '"Lake" is curated.' } } });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    await clickAndSettle('github-connect-btn');

    expect(h.toastError).toHaveBeenCalledWith('"Lake" is curated.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('disables the action when the status query errors (non-manager)', () => {
    h.isError.current = true;
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connect-unavailable-btn')).toBeDisabled();
    expect(screen.queryByTestId('github-connect-btn')).toBeNull();
  });

  it('shows an appointed admin the status but no re-sync or disconnect controls', () => {
    h.canManage.current = false;
    h.connection.current = connected({ lastError: 'Rate limited.' });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connection-status')).toHaveTextContent('acme/docs @ main');
    expect(screen.getByTestId('github-connection-last-error')).toHaveTextContent('Rate limited.');
    expect(screen.queryByTestId('github-resync-btn')).toBeNull();
    expect(screen.queryByTestId('github-disconnect-btn')).toBeNull();
  });

  it('keeps Connect disabled for an appointed admin on a lake with no connection yet', () => {
    h.canManage.current = false;
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connect-unavailable-btn')).toBeDisabled();
    expect(screen.queryByTestId('github-connect-btn')).toBeNull();
  });

  it('shows the connected repository and branch with re-sync and disconnect', () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connection-status')).toHaveTextContent('acme/docs @ main');
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('github-access-disclosure')).toBeNull();
    expect(screen.queryByTestId('github-connection-last-error')).toBeNull();

    fireEvent.click(screen.getByTestId('github-resync-btn'));
    expect(h.resyncMutate).toHaveBeenCalledWith('lake1', expect.any(Object));
  });

  it("surfaces the server's reason when a re-sync cannot start, and the fallback otherwise", () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    fireEvent.click(screen.getByTestId('github-resync-btn'));

    const [, options] = h.resyncMutate.mock.calls[0];
    options.onError({
      isAxiosError: true,
      response: { data: { error: 'A sync is already running for this repository' } },
    });
    expect(h.toastError).toHaveBeenCalledWith('A sync is already running for this repository');

    options.onError({});
    expect(h.toastError).toHaveBeenCalledWith('Could not start a re-sync. Please try again.');
  });

  it('confirms a started re-sync with a toast naming the repository', () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    fireEvent.click(screen.getByTestId('github-resync-btn'));

    const [, options] = h.resyncMutate.mock.calls[0];
    options.onSuccess();
    expect(h.toastSuccess).toHaveBeenCalledWith('Re-syncing acme/docs...');
  });

  it.each([
    ['syncing', connected({ status: 'syncing' }), 'Syncing'],
    ['paused (archived lake)', connected({ enabled: false }), 'Paused'],
  ])('blocks re-sync while %s, as sync.ts would 409 it', (_name, connection, label) => {
    h.connection.current = connection;
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent(label);
    expect(screen.getByTestId('github-resync-btn')).toBeDisabled();
  });

  it('offers re-sync and reads Sync stalled once a syncing claim has gone stale', () => {
    h.connection.current = connected({ status: 'syncing', syncStale: true });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Sync stalled');
    expect(screen.getByTestId('github-resync-btn')).toBeEnabled();
  });

  it('keeps re-sync available after the App lost access, so restoring access can recover', () => {
    h.connection.current = connected({ status: 'error', lastError: 'Repository access was removed' });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Sync failed');
    expect(screen.getByTestId('github-resync-btn')).toBeEnabled();
  });

  it('does NOT report a sync that stopped short as Connected', () => {
    h.connection.current = connected({ lastError: 'GitHub rate-limited this sync.' });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Stopped short');
    expect(screen.getByTestId('github-connection-last-error')).toHaveTextContent('rate-limited');
  });

  it('requires a confirm step that states the purge and the file count before disconnecting', () => {
    h.connection.current = connected({ fileCount: 42 });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);

    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    expect(h.disconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('github-disconnect-warning')).toHaveTextContent(/permanently deletes the 42 files/);

    fireEvent.click(screen.getByTestId('github-disconnect-confirm-btn'));
    expect(h.disconnectMutate).toHaveBeenCalledWith('lake1', expect.any(Object));
  });

  it('uses singular wording for exactly one file', () => {
    h.connection.current = connected({ fileCount: 1 });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    expect(screen.getByTestId('github-disconnect-warning')).toHaveTextContent('the 1 file this');
  });

  it('backs out of the confirm without disconnecting', () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    fireEvent.click(screen.getByTestId('github-disconnect-cancel-btn'));
    expect(screen.queryByTestId('github-disconnect-warning')).toBeNull();
    expect(h.disconnectMutate).not.toHaveBeenCalled();
  });

  it("surfaces the server's reason when disconnect fails, and the fallback otherwise", () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    fireEvent.click(screen.getByTestId('github-disconnect-confirm-btn'));

    const [, options] = h.disconnectMutate.mock.calls[0];
    options.onError({
      isAxiosError: true,
      response: { data: { error: 'A sync is already running for this repository' } },
    });
    expect(h.toastError).toHaveBeenCalledWith('A sync is already running for this repository');

    options.onError({});
    expect(h.toastError).toHaveBeenCalledWith('Could not disconnect. Please try again.');
  });

  it('closes the confirm step and shows a success toast once disconnect completes', () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    fireEvent.click(screen.getByTestId('github-disconnect-confirm-btn'));

    const [, options] = h.disconnectMutate.mock.calls[0];
    act(() => {
      options.onSuccess();
    });

    expect(h.toastSuccess).toHaveBeenCalledWith(
      'Disconnecting acme/docs. Its files are being removed in the background.'
    );
    expect(screen.queryByTestId('github-disconnect-warning')).toBeNull();
  });

  it('reads Disconnecting while the queued purge runs, with no Re-sync and no retry yet', () => {
    h.connection.current = connected({ disconnecting: true, fileCount: 7 });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);

    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Disconnecting');
    expect(screen.getByTestId('github-disconnecting-note')).toHaveTextContent('Removing 7 remaining files');
    expect(screen.queryByTestId('github-resync-btn')).toBeNull();
    // A retry now would only start a second purge chain over the same files.
    const button = screen.getByTestId('github-disconnect-btn');
    expect(button).toHaveTextContent('Disconnecting');
    expect(button).toBeDisabled();
  });

  it('says it is finishing up rather than removing 0 files', () => {
    h.connection.current = connected({ disconnecting: true, fileCount: 0 });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-disconnecting-note')).toHaveTextContent('Finishing disconnect...');
  });

  it('uses singular wording for exactly one remaining file in the disconnecting note', () => {
    h.connection.current = connected({ disconnecting: true, fileCount: 1 });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    expect(screen.getByTestId('github-disconnecting-note')).toHaveTextContent('Removing 1 remaining file in');
  });

  it('offers Retry disconnect once the purge looks stalled, so it can be re-queued', () => {
    h.connection.current = connected({ disconnecting: true, disconnectStalled: true });
    wrap(<GitHubConnectAction lake={FED_LAKE} />);

    const button = screen.getByTestId('github-disconnect-btn');
    expect(button).toHaveTextContent('Retry disconnect');
    expect(button).not.toBeDisabled();
  });

  describe('sync summary', () => {
    it('shows when the lake last synced and links the 7-character commit to GitHub', () => {
      h.connection.current = connected({
        lastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        lastSyncedCommitSha: 'abcdef1234567890',
      });
      wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);

      expect(screen.getByTestId('github-connection-last-synced')).toHaveTextContent(/Last synced .*abcdef1/);
      const link = screen.getByTestId('github-connection-commit-link');
      expect(link).toHaveTextContent('abcdef1');
      expect(link).not.toHaveTextContent('abcdef12');
      expect(link).toHaveAttribute('href', 'https://github.com/acme/docs/commit/abcdef1234567890');
    });

    it('says Not synced yet when no sync has completed', () => {
      h.connection.current = connected({ lastSyncedAt: null });
      wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
      expect(screen.getByTestId('github-connection-last-synced')).toHaveTextContent('Not synced yet');
      expect(screen.queryByTestId('github-connection-commit-link')).toBeNull();
    });

    it('shows synced and skipped counts, and the skip count opens the sync rules', () => {
      h.connection.current = connected({ fileCount: 12, skippedCount: 3 });
      wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
      expect(screen.getByTestId('github-connection-counts')).toHaveTextContent('12 files synced, 3 skipped');
      expect(screen.queryByTestId('github-sync-rules-modal')).toBeNull();

      fireEvent.click(screen.getByTestId('github-sync-rules-link'));
      expect(screen.getByTestId('github-sync-rules-modal')).toBeInTheDocument();
    });

    it('points at the sync rules when the skipped count is unknown', () => {
      h.connection.current = connected({ fileCount: 12, skippedCount: null });
      wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
      expect(screen.getByTestId('github-sync-rules-link')).toHaveTextContent('see sync rules');
    });

    it('shows live progress while a sync runs', () => {
      h.connection.current = connected({ status: 'syncing', fileCount: 4, candidateCount: 10 });
      wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
      expect(screen.getByTestId('github-sync-progress-count')).toHaveTextContent('4 of 10 files indexed');
    });

    it('shows no progress when no sync is running', () => {
      h.connection.current = connected({ status: 'connected', fileCount: 4, candidateCount: 10 });
      wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
      expect(screen.queryByTestId('github-sync-progress')).toBeNull();
    });
  });

  describe('Ask about this repo', () => {
    const SYNCED_AT = '2026-02-01T00:00:00.000Z';

    it('starts a chat scoped to the lake once a sync has completed', () => {
      h.connection.current = connected({ lastSyncedAt: SYNCED_AT });
      wrap(<GitHubConnectAction lake={{ id: 'lake1', status: 'active' }} />);

      const button = screen.getByTestId('github-ask-about-repo-btn');
      expect(button).toHaveTextContent('Ask about this repo');
      fireEvent.click(button);
      expect(h.startChatWithLake).toHaveBeenCalledWith('lake1');
    });

    it('is hidden during a first sync, which has not finished landing the repo', () => {
      h.connection.current = connected({ status: 'syncing', lastSyncedAt: null });
      wrap(<GitHubConnectAction lake={{ id: 'lake1', status: 'active' }} />);
      expect(screen.queryByTestId('github-ask-about-repo-btn')).toBeNull();
    });

    it('is shown during a re-sync of an already-synced lake', () => {
      h.connection.current = connected({ status: 'syncing', lastSyncedAt: SYNCED_AT });
      wrap(<GitHubConnectAction lake={{ id: 'lake1', status: 'active' }} />);
      expect(screen.getByTestId('github-ask-about-repo-btn')).toBeInTheDocument();
    });

    it('is hidden when no files have synced', () => {
      h.connection.current = connected({ lastSyncedAt: SYNCED_AT, fileCount: 0 });
      wrap(<GitHubConnectAction lake={{ id: 'lake1', status: 'active' }} />);
      expect(screen.queryByTestId('github-ask-about-repo-btn')).toBeNull();
    });

    it('is hidden while disconnecting', () => {
      h.connection.current = connected({ lastSyncedAt: SYNCED_AT, disconnecting: true });
      wrap(<GitHubConnectAction lake={{ id: 'lake1', status: 'active' }} />);
      expect(screen.queryByTestId('github-ask-about-repo-btn')).toBeNull();
    });

    it('confirms before chatting with a draft lake instead of starting right away', () => {
      h.connection.current = connected({ lastSyncedAt: SYNCED_AT });
      wrap(<GitHubConnectAction lake={{ id: 'lake1', status: 'draft' }} />);

      fireEvent.click(screen.getByTestId('github-ask-about-repo-btn'));
      expect(screen.getByTestId('datalake-startchat-draft-modal')).toBeInTheDocument();
      expect(h.startChatWithLake).not.toHaveBeenCalled();
    });
  });
});

describe('GitHubConnectAction on a lake that is not connector-fed', () => {
  const openPrompt = (lake: { id: string; origin?: 'curated' | 'connector-fed' }) => {
    const utils = wrap(<GitHubConnectAction lake={lake} />);
    fireEvent.click(screen.getByTestId('github-connect-btn'));
    return utils;
  };

  it('asks to switch a curated lake before starting the connect, saying the switch is lake-wide', () => {
    openPrompt({ id: 'lake1', origin: 'curated' });
    const prompt = screen.getByTestId('github-switch-origin-prompt');
    expect(prompt).toHaveTextContent('Switch this lake to connector-fed to connect a repository?');
    expect(prompt).toHaveTextContent(/whole lake: any connector or scheduled import can then add files/);
    expect(h.startMutateAsync).not.toHaveBeenCalled();
  });

  it('treats an absent origin as curated and asks too', () => {
    openPrompt({ id: 'lake1' });
    expect(screen.getByTestId('github-switch-origin-prompt')).toBeInTheDocument();
    expect(h.startMutateAsync).not.toHaveBeenCalled();
  });

  it('switches and starts in one request, leaving the origin write to the server', async () => {
    openPrompt({ id: 'lake1', origin: 'curated' });
    await clickAndSettle('github-switch-origin-confirm-btn');
    expect(h.startMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.startMutateAsync).toHaveBeenCalledWith({ dataLakeId: 'lake1', ensureConnectorFed: true });
    expect(h.saveHandoff).toHaveBeenCalledWith({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(URLS.authorizeUrl);
  });

  it('surfaces a refused switch-and-start and does not leave for GitHub', async () => {
    h.startMutateAsync.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: 'already connected to a Google Drive folder' } },
    });
    openPrompt({ id: 'lake1', origin: 'curated' });
    await clickAndSettle('github-switch-origin-confirm-btn');
    expect(h.toastError).toHaveBeenCalledWith('already connected to a Google Drive folder');
    expect(h.startMutateAsync).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not leave for GitHub when the handoff cannot be saved after the switch', async () => {
    h.saveHandoff.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    openPrompt({ id: 'lake1', origin: 'curated' });
    await clickAndSettle('github-switch-origin-confirm-btn');
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/session storage/));
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows the confirm as loading and locks cancel while the start is pending', () => {
    const { rerender } = openPrompt({ id: 'lake1', origin: 'curated' });
    h.startPending.current = true;
    rerender(
      <CssVarsProvider theme={appTheme}>
        <GitHubConnectAction lake={{ id: 'lake1', origin: 'curated' }} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('github-switch-origin-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('github-switch-origin-cancel-btn')).toBeDisabled();
  });

  it('still leaves for GitHub when the panel unmounts while the start is in flight', async () => {
    let resolveStart!: (value: typeof URLS) => void;
    h.startMutateAsync.mockReturnValue(new Promise(resolve => (resolveStart = resolve)));
    const { unmount } = openPrompt({ id: 'lake1', origin: 'curated' });
    fireEvent.click(screen.getByTestId('github-switch-origin-confirm-btn'));
    unmount();
    await act(async () => resolveStart(URLS));
    expect(assign).toHaveBeenCalledWith(URLS.authorizeUrl);
  });

  it('closes a prompt opened on one lake when another lake is selected', () => {
    const { rerender } = wrap(<GitHubConnectAction lake={{ id: 'lake1', origin: 'curated' }} />);
    fireEvent.click(screen.getByTestId('github-connect-btn'));
    expect(screen.getByTestId('github-switch-origin-prompt')).toBeInTheDocument();
    rerender(
      <CssVarsProvider theme={appTheme}>
        <GitHubConnectAction lake={{ id: 'lake2', origin: 'curated' }} />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('github-switch-origin-prompt')).not.toBeInTheDocument();
  });

  it('cancels without starting the connect', () => {
    openPrompt({ id: 'lake1', origin: 'curated' });
    fireEvent.click(screen.getByTestId('github-switch-origin-cancel-btn'));
    expect(screen.queryByTestId('github-switch-origin-prompt')).not.toBeInTheDocument();
    expect(h.startMutateAsync).not.toHaveBeenCalled();
  });

  it('drops the switch prompt and re-enables Connect once the server switch lands', () => {
    const { rerender } = openPrompt({ id: 'lake1', origin: 'curated' });
    expect(screen.getByTestId('github-switch-origin-prompt')).toBeInTheDocument();
    rerender(
      <CssVarsProvider theme={appTheme}>
        <GitHubConnectAction lake={{ id: 'lake1', origin: 'connector-fed' }} />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('github-switch-origin-prompt')).not.toBeInTheDocument();
    expect(screen.getByTestId('github-connect-btn')).not.toBeDisabled();
  });

  it('starts the connect directly on a connector-fed lake, with no prompt and no switch', async () => {
    wrap(<GitHubConnectAction lake={FED_LAKE} />);
    await clickAndSettle('github-connect-btn');
    expect(screen.queryByTestId('github-switch-origin-prompt')).not.toBeInTheDocument();
    expect(h.startMutateAsync).toHaveBeenCalledWith({ dataLakeId: 'lake1', ensureConnectorFed: undefined });
  });
});
