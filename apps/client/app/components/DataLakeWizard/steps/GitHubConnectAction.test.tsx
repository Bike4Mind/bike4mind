import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';

const h = vi.hoisted(() => ({
  connection: { current: null as LakeGitHubConnection | null },
  isError: { current: false },
  startMutate: vi.fn(),
  resyncMutate: vi.fn(),
  disconnectMutate: vi.fn(),
  saveHandoff: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: () => ({ data: h.connection.current, isLoading: false, isError: h.isError.current }),
  useStartLakeGitHubConnect: () => ({ mutate: h.startMutate, isPending: false }),
  useResyncLakeGitHub: () => ({ mutate: h.resyncMutate, isPending: false }),
  useDisconnectLakeGitHub: () => ({ mutate: h.disconnectMutate, isPending: false }),
}));
vi.mock('@client/app/utils/githubLakeConnectHandoff', () => ({ saveGitHubLakeConnectHandoff: h.saveHandoff }));
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
  syncStale: false,
  fileCount: 3,
  disconnecting: false,
  disconnectStalled: false,
  ...over,
});

const URLS = {
  authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=c&state=s1',
};

const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.connection.current = null;
  h.isError.current = false;
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Resolve the start mutation the way react-query would, with the server's connect URLs. */
const resolveStart = () => {
  const [, options] = h.startMutate.mock.calls[0];
  options.onSuccess(URLS);
};

describe('GitHubConnectAction', () => {
  it('offers Connect GitHub, with its read-only disclosure, when the lake has no repository', () => {
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connect-btn')).not.toBeDisabled();
    expect(screen.getByTestId('github-access-disclosure')).toHaveTextContent(/approve the GitHub App/);
  });

  it('saves the handoff for the callback page, then sends the browser to the authorize page', () => {
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('github-connect-btn'));
    expect(h.startMutate).toHaveBeenCalledWith('lake1', expect.any(Object));

    resolveStart();
    expect(h.saveHandoff).toHaveBeenCalledWith({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(URLS.authorizeUrl);
  });

  it('does not leave for GitHub when the handoff cannot be saved, since the callback could not finish', () => {
    h.saveHandoff.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('github-connect-btn'));

    resolveStart();
    expect(assign).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/session storage/));
  });

  it("surfaces the server's reason when the connect cannot start", () => {
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('github-connect-btn'));

    const [, options] = h.startMutate.mock.calls[0];
    options.onError({ isAxiosError: true, response: { data: { error: '"Lake" is curated.' } } });
    expect(h.toastError).toHaveBeenCalledWith('"Lake" is curated.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('disables the action when the status query errors (non-manager)', () => {
    h.isError.current = true;
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connect-unavailable-btn')).toBeDisabled();
    expect(screen.queryByTestId('github-connect-btn')).toBeNull();
  });

  it('shows the connected repository and branch with re-sync and disconnect', () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connection-status')).toHaveTextContent('acme/docs @ main');
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('github-access-disclosure')).toBeNull();
    expect(screen.queryByTestId('github-connection-last-error')).toBeNull();

    fireEvent.click(screen.getByTestId('github-resync-btn'));
    expect(h.resyncMutate).toHaveBeenCalledWith('lake1', expect.any(Object));
  });

  it("surfaces the server's reason when a re-sync cannot start, and the fallback otherwise", () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
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
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
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
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent(label);
    expect(screen.getByTestId('github-resync-btn')).toBeDisabled();
  });

  it('offers re-sync and reads Sync stalled once a syncing claim has gone stale', () => {
    h.connection.current = connected({ status: 'syncing', syncStale: true });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Sync stalled');
    expect(screen.getByTestId('github-resync-btn')).toBeEnabled();
  });

  it('keeps re-sync available after the App lost access, so restoring access can recover', () => {
    h.connection.current = connected({ status: 'error', lastError: 'Repository access was removed' });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Sync failed');
    expect(screen.getByTestId('github-resync-btn')).toBeEnabled();
  });

  it('does NOT report a sync that stopped short as Connected', () => {
    h.connection.current = connected({ lastError: 'GitHub rate-limited this sync.' });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connection-status-chip')).toHaveTextContent('Stopped short');
    expect(screen.getByTestId('github-connection-last-error')).toHaveTextContent('rate-limited');
  });

  it('requires a confirm step that states the purge and the file count before disconnecting', () => {
    h.connection.current = connected({ fileCount: 42 });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);

    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    expect(h.disconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('github-disconnect-warning')).toHaveTextContent(/permanently deletes the 42 files/);

    fireEvent.click(screen.getByTestId('github-disconnect-confirm-btn'));
    expect(h.disconnectMutate).toHaveBeenCalledWith('lake1', expect.any(Object));
  });

  it('uses singular wording for exactly one file', () => {
    h.connection.current = connected({ fileCount: 1 });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    expect(screen.getByTestId('github-disconnect-warning')).toHaveTextContent('the 1 file this');
  });

  it('backs out of the confirm without disconnecting', () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));
    fireEvent.click(screen.getByTestId('github-disconnect-cancel-btn'));
    expect(screen.queryByTestId('github-disconnect-warning')).toBeNull();
    expect(h.disconnectMutate).not.toHaveBeenCalled();
  });

  it("surfaces the server's reason when disconnect fails, and the fallback otherwise", () => {
    h.connection.current = connected();
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
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
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
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
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);

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
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-disconnecting-note')).toHaveTextContent('Finishing disconnect...');
  });

  it('uses singular wording for exactly one remaining file in the disconnecting note', () => {
    h.connection.current = connected({ disconnecting: true, fileCount: 1 });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-disconnecting-note')).toHaveTextContent('Removing 1 remaining file in');
  });

  it('offers Retry disconnect once the purge looks stalled, so it can be re-queued', () => {
    h.connection.current = connected({ disconnecting: true, disconnectStalled: true });
    wrap(<GitHubConnectAction lake={{ id: 'lake1' }} />);

    const button = screen.getByTestId('github-disconnect-btn');
    expect(button).toHaveTextContent('Retry disconnect');
    expect(button).not.toBeDisabled();
  });
});
