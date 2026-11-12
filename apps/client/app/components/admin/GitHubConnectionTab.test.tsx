import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  useAdminGitHubRepositories: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.delete },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/hooks/data/useGitHubRepositories', () => ({
  useAdminGitHubRepositories: mocks.useAdminGitHubRepositories,
}));

import GitHubConnectionTab from './GitHubConnectionTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GitHubConnectionTab />
    </CssVarsProvider>
  );

const APP_CONNECTION = {
  id: 'conn-1',
  connectionType: 'github_app',
  appId: '123456',
  installationId: '987654',
  repositorySelection: 'all',
  privateKeyMasked: '-----BEGIN RSA PRIVATE KEY-----****',
  connectedAt: '2026-01-01T00:00:00.000Z',
  health: { lastUsedAt: '2026-10-01T00:00:00.000Z', lastLatencyMs: 300 },
  permissions: { issues: 'write', contents: 'read' },
  allowedRepositories: ['acme/widgets'],
};
const RATE_LIMIT = {
  limit: 5000,
  remaining: 4000,
  resetAt: '2026-10-01T01:00:00.000Z',
  usagePercent: 20,
  isNearLimit: false,
};

/** Routes the tab's two GETs; `rateLimit` false makes the rate-limit read fail. */
const routeGets = (connection: Record<string, unknown> | null, rateLimit: unknown = RATE_LIMIT) =>
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/api/admin/github/connection') return { data: { connected: connection !== null, connection } };
    if (url === '/api/admin/github/rate-limit') {
      if (rateLimit === false) throw new Error('rate limit unavailable');
      return { data: { rateLimit } };
    }
    throw new Error(`unexpected GET ${url}`);
  });

const header = () => screen.getByTestId('admin-page-header');
const pickReason = (dialogTestId: string) =>
  fireEvent.click(screen.getByTestId(`${dialogTestId}-reason-input-preset-0`));

/** Tries Cancel, the close button and Esc on an ActionDialog; a busy dialog ignores all three. */
const tryToClose = (dialogTestId: string) => {
  fireEvent.click(screen.getByTestId(`${dialogTestId}-cancel-btn`));
  fireEvent.click(screen.getByTestId(`${dialogTestId}-close-btn`));
  fireEvent.keyDown(screen.getByTestId(dialogTestId), { key: 'Escape' });
};

/** Opens Disconnect from the header, picks a reason and confirms. */
const confirmDisconnect = async () => {
  await screen.findByTestId('github-connection-details');
  fireEvent.click(within(header()).getByTestId('github-disconnect-btn'));
  await screen.findByTestId('github-disconnect-dialog');
  pickReason('github-disconnect-dialog');
  fireEvent.click(screen.getByTestId('github-disconnect-confirm-btn'));
};

/** Makes the Edit checklist list acme/widgets, the one repository the connection allows. */
const listOneRepository = () =>
  mocks.useAdminGitHubRepositories.mockImplementation((enabled: boolean) => ({
    data: enabled ? { repositories: [{ id: 1, full_name: 'acme/widgets', private: true }], hasMore: false } : undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }));

/** Unticks the only allowed repository, saves, and confirms the empty-whitelist dialog. */
const confirmEmptyWhitelist = async () => {
  await screen.findByTestId('github-connection-details');
  fireEvent.click(screen.getByTestId('github-edit-repos-btn'));
  fireEvent.click(within(await screen.findByTestId('github-repo-checkbox-1')).getByRole('checkbox'));
  fireEvent.click(screen.getByTestId('github-save-repos-btn'));
  await screen.findByTestId('github-empty-repos-dialog');
  pickReason('github-empty-repos-dialog');
  fireEvent.click(screen.getByTestId('github-empty-repos-dialog-confirm-btn'));
};

/** Opens Rotate private key from the header, picks a reason, pastes a key and confirms. */
const confirmRotate = async () => {
  await screen.findByTestId('github-connection-details');
  fireEvent.click(within(header()).getByTestId('github-rotate-key-btn'));
  await screen.findByTestId('github-rotate-key-dialog');
  pickReason('github-rotate-key-dialog');
  fireEvent.change(screen.getByTestId('github-new-private-key-input'), { target: { value: 'NEW PEM' } });
  fireEvent.click(screen.getByTestId('github-rotate-key-confirm-btn'));
};

const PAT_CONNECTION = {
  id: 'conn-2',
  connectionType: 'service_account',
  accessTokenMasked: 'github_pat_****',
  connectedAt: '2026-01-01T00:00:00.000Z',
  health: { lastUsedAt: '2026-10-01T00:00:00.000Z', lastLatencyMs: 300 },
  allowedRepositories: ['acme/widgets'],
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** An expiry that daysUntil rounds up to `days`. */
const expiresIn = (days: number) => new Date(Date.now() + days * DAY_MS - 60 * 1000).toISOString();

beforeEach(() => {
  [mocks.get, mocks.post, mocks.put, mocks.delete, mocks.toast.success, mocks.toast.error].forEach(mock =>
    mock.mockReset()
  );
  mocks.useAdminGitHubRepositories.mockReset();
  mocks.useAdminGitHubRepositories.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  routeGets(APP_CONNECTION);
});

describe('GitHubConnectionTab page anatomy and states', () => {
  it('opens with the page header: sentence-case title with no icon, and its actions', async () => {
    renderTab();
    await screen.findByTestId('github-connection-details');
    expect(screen.getByTestId('github-connection-tab').firstElementChild).toBe(header());
    const title = within(header()).getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('GitHub connection');
    expect(title.querySelector('svg')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const id of ['github-connection-refresh-btn', 'github-rotate-key-btn', 'github-disconnect-btn']) {
      expect(within(header()).getByTestId(id)).toBeInTheDocument();
    }
  });

  it('shows LoadingState under the header on the first load', async () => {
    let resolveConnection: (value: unknown) => void = () => undefined;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => (resolveConnection = resolve)));
    renderTab();
    expect(header()).toBeInTheDocument();
    expect(screen.getByTestId('admin-loading-state')).toHaveTextContent('Loading GitHub connection');
    await act(async () => resolveConnection({ data: { connected: false, connection: null } }));
    expect(screen.queryByTestId('admin-loading-state')).toBeNull();
  });

  it('shows a failed load as ErrorState with Try again, and recovers', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Network Error'));
    renderTab();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('The GitHub connection failed to load.');
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(within(header()).queryByTestId('github-disconnect-btn')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('github-connection-details')).toBeInTheDocument();
  });

  it('keeps the connection on screen under UpdatingBar while Refresh reloads', async () => {
    renderTab();
    await screen.findByTestId('github-connection-details');
    let resolveConnection: (value: unknown) => void = () => undefined;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => (resolveConnection = resolve)));

    fireEvent.click(within(header()).getByTestId('github-connection-refresh-btn'));
    expect(await screen.findByTestId('github-connection-updating')).toBeInTheDocument();
    expect(screen.getByTestId('github-connection-details')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-loading-state')).toBeNull();

    await act(async () => resolveConnection({ data: { connected: true, connection: APP_CONNECTION } }));
    expect(screen.queryByTestId('github-connection-updating')).toBeNull();
  });

  it('replaces the dashed card with EmptyState whose actions open the connect dialogs', async () => {
    routeGets(null);
    mocks.post.mockResolvedValue({ data: {} });
    renderTab();
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No GitHub connection');
    expect(within(empty).getByTestId('github-connect-pat-btn')).toBeInTheDocument();
    expect(within(header()).queryByTestId('github-disconnect-btn')).toBeNull();

    fireEvent.click(within(empty).getByTestId('github-connect-app-btn'));
    const dialog = await screen.findByTestId('github-connect-app-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Connect GitHub App');
    fireEvent.change(screen.getByTestId('github-app-id-input'), { target: { value: '42' } });
    fireEvent.change(screen.getByTestId('github-installation-id-input'), { target: { value: '7' } });
    fireEvent.change(screen.getByTestId('github-private-key-input'), { target: { value: 'PEM' } });
    fireEvent.click(screen.getByTestId('github-connect-app-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        '/api/admin/github/connection',
        { connectionType: 'github_app', appId: '42', installationId: '7', privateKey: 'PEM' },
        { signal: expect.any(AbortSignal) }
      )
    );
  });

  it('shows the connection as one SectionCard of facts with no card inside it, and a toned health chip', async () => {
    renderTab();
    const details = await screen.findByTestId('github-connection-details');
    expect(within(details).getByRole('heading', { level: 3 })).toHaveTextContent('GitHub App');
    expect(details.querySelector('section')).toBeNull();
    const facts = Array.from(details.querySelectorAll('dt')).map(term => term.textContent);
    expect(facts).toEqual(['App ID', 'Installation ID', 'Repository access', 'Private key', 'Connected at']);
    const health = within(details).getByTestId('github-health-status-chip');
    expect(health).toHaveTextContent('Healthy');
    expect(health).toHaveAttribute('data-tone', 'good');
  });

  it.each([
    [{ ...APP_CONNECTION, suspendedAt: '2026-09-01T00:00:00.000Z' }, 'Suspended', 'bad'],
    [{ ...APP_CONNECTION, health: { lastUsedAt: '2026-10-01T00:00:00.000Z', lastLatencyMs: 2500 } }, 'Slow', 'warn'],
    [{ ...APP_CONNECTION, health: {} }, 'Unknown', 'neutral'],
  ])('tones the health chip by status (%#)', async (connection, label, tone) => {
    routeGets(connection);
    renderTab();
    const health = await screen.findByTestId('github-health-status-chip');
    expect(health).toHaveTextContent(label);
    expect(health).toHaveAttribute('data-tone', tone);
  });

  it('puts the suspension banner between the header and the details', async () => {
    routeGets({ ...APP_CONNECTION, suspendedAt: '2026-09-01T00:00:00.000Z' });
    renderTab();
    const details = await screen.findByTestId('github-connection-details');
    const banner = screen.getByTestId('github-suspended-alert');
    expect(header().compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a failed rate-limit read as ErrorState with Try again', async () => {
    routeGets(APP_CONNECTION, false);
    renderTab();
    const card = await screen.findByTestId('github-rate-limit');
    expect(await within(card).findByTestId('admin-error-state')).toHaveTextContent('The rate limit failed to load.');

    routeGets(APP_CONNECTION);
    fireEvent.click(within(card).getByTestId('admin-error-retry-btn'));
    expect(await within(card).findByText('4,000 / 5,000 remaining')).toBeInTheDocument();
  });

  it('reports a test connection as a toned banner', async () => {
    mocks.post.mockResolvedValueOnce({ data: { success: true, type: 'app', appName: 'Triage bot', latencyMs: 120 } });
    renderTab();
    fireEvent.click(await screen.findByTestId('github-test-connection-btn'));
    const banner = await screen.findByTestId('github-test-result-alert');
    expect(banner).toHaveTextContent('Connection successful');
    expect(getComputedStyle(banner).backgroundColor).toContain('success');

    mocks.post.mockRejectedValueOnce(new Error('Bad credentials'));
    fireEvent.click(screen.getByTestId('github-test-connection-btn'));
    await waitFor(() => expect(screen.getByTestId('github-test-result-alert')).toHaveTextContent('Connection failed'));
    expect(getComputedStyle(screen.getByTestId('github-test-result-alert')).backgroundColor).toContain('danger');
  });
});

describe('GitHubConnectionTab destructive dialogs', () => {
  it('confirms Disconnect in a danger ActionDialog before the DELETE', async () => {
    mocks.delete.mockResolvedValue({ data: {} });
    renderTab();
    await screen.findByTestId('github-connection-details');

    const trigger = within(header()).getByTestId('github-disconnect-btn');
    expect(trigger).toHaveTextContent('Disconnect GitHub');
    fireEvent.click(trigger);
    const dialog = await screen.findByTestId('github-disconnect-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Disconnect GitHub');
    const confirm = screen.getByTestId('github-disconnect-confirm-btn');
    expect(confirm).toBeDisabled();
    expect(mocks.delete).not.toHaveBeenCalled();

    pickReason('github-disconnect-dialog');
    expect(getComputedStyle(confirm).backgroundColor).toContain('danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/admin/github/connection'));
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('admin-empty-state')).toHaveTextContent('No GitHub connection');
  });

  it('holds the Disconnect confirm open while its DELETE runs', async () => {
    let resolveDelete: (value: unknown) => void = () => undefined;
    mocks.delete.mockImplementation(() => new Promise(resolve => (resolveDelete = resolve)));
    renderTab();
    await confirmDisconnect();
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));

    tryToClose('github-disconnect-dialog');
    expect(screen.getByTestId('github-disconnect-dialog')).toBeInTheDocument();

    await act(async () => resolveDelete({ data: {} }));
    expect(await screen.findByTestId('admin-empty-state')).toHaveTextContent('No GitHub connection');
    expect(screen.queryByTestId('github-disconnect-dialog')).toBeNull();
  });

  it('keeps the Disconnect confirm open with a toast and the connection on screen when the DELETE fails', async () => {
    mocks.delete.mockRejectedValue(new Error('Server error'));
    renderTab();
    await confirmDisconnect();

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Server error'));
    expect(screen.getByTestId('github-disconnect-dialog')).toBeInTheDocument();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('github-connection-details')).toBeInTheDocument();
    expect(within(header()).getByTestId('github-disconnect-btn')).toBeInTheDocument();
  });

  it('confirms a key rotation in a danger ActionDialog that waits for the new key, with the same payload', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    renderTab();
    await screen.findByTestId('github-connection-details');

    fireEvent.click(within(header()).getByTestId('github-rotate-key-btn'));
    const dialog = await screen.findByTestId('github-rotate-key-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Rotate private key');
    pickReason('github-rotate-key-dialog');
    const confirm = screen.getByTestId('github-rotate-key-confirm-btn');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('github-rotate-key-dialog-hint')).toHaveTextContent(
      'Paste the new private key to rotate.'
    );

    fireEvent.change(screen.getByTestId('github-new-private-key-input'), { target: { value: 'NEW PEM' } });
    expect(getComputedStyle(confirm).backgroundColor).toContain('danger');
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/github/rotate-key', { privateKey: 'NEW PEM' })
    );
  });

  it('confirms saving an empty whitelist in a danger ActionDialog before the PUT', async () => {
    mocks.put.mockResolvedValue({ data: {} });
    mocks.useAdminGitHubRepositories.mockImplementation((enabled: boolean) => ({
      data: enabled
        ? { repositories: [{ id: 1, full_name: 'acme/widgets', private: true }], hasMore: false }
        : undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }));
    renderTab();
    await screen.findByTestId('github-connection-details');

    fireEvent.click(screen.getByTestId('github-edit-repos-btn'));
    fireEvent.click(within(await screen.findByTestId('github-repo-checkbox-1')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('github-save-repos-btn'));
    const dialog = await screen.findByTestId('github-empty-repos-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Save an empty repository whitelist');
    expect(mocks.put).not.toHaveBeenCalled();

    pickReason('github-empty-repos-dialog');
    const confirm = screen.getByTestId('github-empty-repos-dialog-confirm-btn');
    expect(getComputedStyle(confirm).backgroundColor).toContain('danger');
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/admin/github/connection', { allowedRepositories: [] })
    );
  });

  it('holds the empty-whitelist confirm open while its PUT runs', async () => {
    let resolvePut: (value: unknown) => void = () => undefined;
    mocks.put.mockImplementation(() => new Promise(resolve => (resolvePut = resolve)));
    listOneRepository();
    renderTab();
    await confirmEmptyWhitelist();
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));

    tryToClose('github-empty-repos-dialog');
    expect(screen.getByTestId('github-empty-repos-dialog')).toBeInTheDocument();

    await act(async () => resolvePut({ data: {} }));
    await waitFor(() => expect(screen.queryByTestId('github-empty-repos-dialog')).toBeNull());
  });

  it('keeps the empty-whitelist confirm open with a toast and the list unchanged when the PUT fails', async () => {
    mocks.put.mockRejectedValue(new Error('Server error'));
    listOneRepository();
    renderTab();
    await confirmEmptyWhitelist();

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Server error'));
    expect(screen.getByTestId('github-empty-repos-dialog')).toBeInTheDocument();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.get.mock.calls.filter(([url]) => url === '/api/admin/github/connection')).toHaveLength(1);
  });

  it('holds the Rotate confirm open while its POST runs', async () => {
    let resolvePost: (value: unknown) => void = () => undefined;
    mocks.post.mockImplementation(() => new Promise(resolve => (resolvePost = resolve)));
    renderTab();
    await confirmRotate();
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));

    tryToClose('github-rotate-key-dialog');
    expect(screen.getByTestId('github-rotate-key-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('github-new-private-key-input')).toHaveValue('NEW PEM');

    await act(async () => resolvePost({ data: {} }));
    await waitFor(() => expect(screen.queryByTestId('github-rotate-key-dialog')).toBeNull());
  });

  it('keeps the Rotate confirm open with a toast and the pasted key when the POST fails', async () => {
    mocks.post.mockRejectedValue(new Error('Invalid private key'));
    renderTab();
    await confirmRotate();

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Invalid private key'));
    expect(screen.getByTestId('github-rotate-key-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('github-new-private-key-input')).toHaveValue('NEW PEM');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

describe('GitHubConnectionTab service account PAT and repositories', () => {
  it('connects a PAT from the empty state with the same payload', async () => {
    routeGets(null);
    mocks.post.mockResolvedValue({ data: {} });
    renderTab();
    fireEvent.click(within(await screen.findByTestId('admin-empty-state')).getByTestId('github-connect-pat-btn'));
    const dialog = await screen.findByTestId('github-connect-pat-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Connect service account PAT');
    expect(screen.getByTestId('github-connect-pat-confirm-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('github-pat-input'), { target: { value: 'github_pat_abc' } });
    fireEvent.change(screen.getByTestId('github-pat-expiry-input'), { target: { value: '2027-01-31' } });
    routeGets(PAT_CONNECTION);
    fireEvent.click(screen.getByTestId('github-connect-pat-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        '/api/admin/github/connection',
        {
          connectionType: 'service_account',
          accessToken: 'github_pat_abc',
          patExpiresAt: '2027-01-31T00:00:00.000Z',
        },
        { signal: expect.any(AbortSignal) }
      )
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Service account PAT connected');
    const details = await screen.findByTestId('github-connection-details');
    expect(within(details).getByRole('heading', { level: 3 })).toHaveTextContent('Service account PAT');
    expect(screen.queryByTestId('github-connect-pat-dialog')).toBeNull();
  });

  it.each([
    [6, 'PAT expires in 6 days. Consider rotating soon.', 'warning'],
    [2, 'PAT expires in 2 days. Consider rotating soon.', 'danger'],
    [-1, 'PAT has expired! Please update with a new token.', 'danger'],
  ])('warns about a PAT expiring in %i days under the header', async (days, text, color) => {
    routeGets({ ...PAT_CONNECTION, patExpiresAt: expiresIn(days) });
    renderTab();
    const details = await screen.findByTestId('github-connection-details');
    const banner = screen.getByTestId('github-pat-expiry-warning');
    expect(banner).toHaveTextContent(text);
    expect(getComputedStyle(banner).backgroundColor).toContain(color);
    expect(header().compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no expiry banner for a PAT with more than a week left', async () => {
    routeGets({ ...PAT_CONNECTION, patExpiresAt: expiresIn(8) });
    renderTab();
    await screen.findByTestId('github-connection-details');
    expect(screen.queryByTestId('github-pat-expiry-warning')).toBeNull();
  });

  it('shows the last API error as a danger banner and an Error health chip', async () => {
    routeGets({ ...APP_CONNECTION, health: { lastUsedAt: '2026-10-01T00:00:00.000Z', lastError: 'Bad credentials' } });
    renderTab();
    const details = await screen.findByTestId('github-connection-details');
    const banner = screen.getByTestId('github-last-error-alert');
    expect(banner).toHaveTextContent('Bad credentials');
    expect(getComputedStyle(banner).backgroundColor).toContain('danger');
    const health = within(details).getByTestId('github-health-status-chip');
    expect(health).toHaveTextContent('Error');
    expect(health).toHaveAttribute('data-tone', 'bad');
  });

  it('saves a non-empty whitelist straight away with the same payload', async () => {
    mocks.put.mockResolvedValue({ data: {} });
    mocks.useAdminGitHubRepositories.mockImplementation((enabled: boolean) => ({
      data: enabled
        ? {
            repositories: [
              { id: 1, full_name: 'acme/widgets', private: true },
              { id: 2, full_name: 'acme/gadgets', private: false },
            ],
            hasMore: false,
          }
        : undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }));
    renderTab();
    await screen.findByTestId('github-connection-details');
    fireEvent.click(screen.getByTestId('github-edit-repos-btn'));
    expect(within(screen.getByTestId('github-select-all')).getByText('Select all')).toBeInTheDocument();
    fireEvent.click(within(await screen.findByTestId('github-repo-checkbox-2')).getByRole('checkbox'));
    expect(within(screen.getByTestId('github-select-all')).getByText('Deselect all')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('github-save-repos-btn'));

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/admin/github/connection', {
        allowedRepositories: ['acme/widgets', 'acme/gadgets'],
      })
    );
    expect(screen.queryByTestId('github-empty-repos-dialog')).toBeNull();
    expect(mocks.toast.success).toHaveBeenCalledWith('Allowed repositories updated');
  });
});
