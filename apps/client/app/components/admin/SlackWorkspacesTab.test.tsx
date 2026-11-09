import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  logEvent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, patch: mocks.patch, delete: mocks.delete },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: mocks.logEvent }) }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('./CreateSlackAppModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="create-slack-app-modal" /> : null),
}));

import SlackWorkspacesTab from './SlackWorkspacesTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SlackWorkspacesTab />
    </CssVarsProvider>
  );

const workspace = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name,
  slackAppId: `A-${id}`,
  slackBotName: 'HelperBot',
  isActive: true,
  installedAt: '2026-01-05T00:00:00.000Z',
  updatedAt: '2026-01-05T00:00:00.000Z',
  ...overrides,
});

const WORKSPACES = [
  workspace('ws-ok', 'Acme', { slackTeamId: 'T1' }),
  workspace('ws-old', 'Beta', { slackTeamId: 'T2' }),
  workspace('ws-token', 'Gamma', { slackTeamId: 'T3', isActive: false }),
  workspace('ws-new', 'Delta', { installedAt: undefined }),
];

const MANIFEST: Record<string, unknown> = {
  'ws-ok': { status: 'up_to_date' },
  'ws-old': {
    status: 'outdated',
    differences: [{ field: 'oauth_config.scopes.bot', actual: ['chat:write'], expected: ['chat:write', 'files:read'] }],
  },
  'ws-token': { status: 'missing_token', message: 'Reconnect required' },
};

/** Routes the tab's GETs: the list, one manifest check per workspace, and export job polls. */
const routeGets = (workspaces: unknown[] = WORKSPACES, job?: Record<string, unknown>) =>
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/api/admin/slack-workspaces') return { data: { workspaces } };
    const manifestId = url.match(/manifest-status\?workspaceId=(.+)$/)?.[1];
    if (manifestId) {
      if (!MANIFEST[manifestId]) throw new Error('Slack API unavailable');
      return { data: MANIFEST[manifestId] };
    }
    if (url.startsWith('/api/slack/export/status/') && job) return { data: { job } };
    throw new Error(`unexpected GET ${url}`);
  });

const loaded = async () => screen.findByTestId('slack-workspaces-table');

/** Picks the first preset reason, which completes an ActionDialog's required reason. */
const pickReason = (dialogTestId: string) =>
  fireEvent.click(screen.getByTestId(`${dialogTestId}-reason-input-preset-0`));

beforeEach(() => {
  Object.values(mocks).forEach(mock => (typeof mock === 'function' ? mock.mockReset() : undefined));
  Object.values(mocks.toast).forEach(mock => mock.mockReset());
  routeGets();
});

describe('SlackWorkspacesTab page anatomy and states', () => {
  it('opens with the page header: title, count and actions, with no logo', async () => {
    renderTab();
    await loaded();
    const tab = screen.getByTestId('slack-workspaces-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Slack workspaces (4)');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).queryByRole('img')).toBeNull();
    expect(within(header).getByTestId('slack-create-app-btn')).toHaveTextContent('Create Slack app');
    expect(within(header).getByTestId('slack-workspaces-refresh-btn')).toBeInTheDocument();
  });

  it('shows LoadingState under the header on the first load', async () => {
    let resolveList: (value: unknown) => void = () => undefined;
    mocks.get.mockImplementation(() => new Promise(resolve => (resolveList = resolve)));
    renderTab();
    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getByTestId('admin-loading-state')).toHaveTextContent('Loading Slack workspaces');
    await act(async () => resolveList({ data: { workspaces: [] } }));
    expect(screen.queryByTestId('admin-loading-state')).toBeNull();
  });

  it('shows a failed load as ErrorState with Try again, and recovers', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Network Error'));
    renderTab();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Slack workspaces failed to load.');
    expect(mocks.toast.error).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await loaded()).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
  });

  it('keeps the rows on screen under UpdatingBar while Refresh reloads', async () => {
    renderTab();
    await loaded();
    let resolveList: (value: unknown) => void = () => undefined;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => (resolveList = resolve)));

    fireEvent.click(screen.getByTestId('slack-workspaces-refresh-btn'));
    expect(await screen.findByTestId('slack-workspaces-updating')).toBeInTheDocument();
    expect(screen.getByTestId('slack-workspace-row-ws-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-loading-state')).toBeNull();

    await act(async () => resolveList({ data: { workspaces: WORKSPACES } }));
    expect(screen.queryByTestId('slack-workspaces-updating')).toBeNull();
  });

  it('shows EmptyState with a Create Slack app action when nothing is connected', async () => {
    routeGets([]);
    renderTab();
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No workspaces connected');
    fireEvent.click(within(empty).getByTestId('slack-workspaces-empty-create-btn'));
    expect(screen.getByTestId('create-slack-app-modal')).toBeInTheDocument();
  });

  it('lists workspaces in a DataTable that scrolls in its own frame, with status tones', async () => {
    renderTab();
    const table = await loaded();
    expect(screen.getByTestId('slack-workspaces-table-frame')).toContainElement(table);
    expect(table).toHaveStyle({ minWidth: '62rem' });

    const tone = (testId: string) => screen.getByTestId(testId).getAttribute('data-tone');
    expect(tone('slack-workspace-status-ws-ok')).toBe('good');
    expect(tone('slack-workspace-status-ws-token')).toBe('neutral');
    expect(tone('slack-workspace-not-installed-ws-new')).toBe('warn');
    expect(screen.getByTestId('slack-workspace-install-btn-ws-new')).toHaveAttribute(
      'href',
      '/integrations/slack/install?workspaceId=ws-new'
    );
    await waitFor(() => expect(tone('manifest-status-ok-ws-ok')).toBe('good'));
    expect(tone('manifest-status-outdated-ws-old')).toBe('warn');
    expect(tone('manifest-status-missing-ws-token')).toBe('bad');
    expect(tone('manifest-status-error-ws-new')).toBe('neutral');
  });
});

describe('SlackWorkspacesTab dialogs', () => {
  it('confirms a deactivation in a danger ActionDialog from the row menu before sending the same PATCH', async () => {
    mocks.patch.mockResolvedValue({ data: {} });
    renderTab();
    await loaded();
    expect(screen.queryByTestId('slack-workspace-deactivate-btn-T1')).toBeNull();

    fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T1'));
    fireEvent.click(await screen.findByTestId('slack-workspace-deactivate-btn-T1'));
    const dialog = await screen.findByTestId('slack-workspace-deactivate-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Deactivate workspace');
    expect(dialog).toHaveTextContent('Acme');
    const confirm = screen.getByTestId('slack-workspace-deactivate-confirm-btn');
    expect(confirm).toBeDisabled();
    expect(mocks.patch).not.toHaveBeenCalled();

    pickReason('slack-workspace-deactivate-dialog');
    expect(confirm).toBeEnabled();
    expect(getComputedStyle(confirm).backgroundColor).toContain('danger');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/api/admin/slack-workspaces', {
        workspaceId: 'ws-ok',
        action: 'deactivate',
      })
    );
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('slack-workspace-deactivate-dialog')).toBeNull());
  });

  it('cannot deactivate a workspace that is already inactive', async () => {
    renderTab();
    await loaded();
    fireEvent.click(screen.getByTestId('slack-workspace-menu-btn-T3'));
    expect(await screen.findByTestId('slack-workspace-deactivate-btn-T3')).toHaveAttribute('aria-disabled', 'true');
  });

  it('opens the export form in an AdminDialog and posts the same export payload', async () => {
    mocks.post.mockResolvedValue({ data: new Blob(['{}']), headers: {} });
    global.URL.createObjectURL = vi.fn(() => 'blob:export');
    global.URL.revokeObjectURL = vi.fn();
    renderTab();
    await loaded();

    fireEvent.click(screen.getByTestId('slack-workspace-export-btn-T1'));
    const dialog = await screen.findByTestId('slack-export-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Export channel history');
    fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C0123' } });
    fireEvent.click(screen.getByTestId('slack-export-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        '/api/slack/export/channel',
        { workspaceId: 'ws-ok', channelId: 'C0123', format: 'json', includeThreads: true, includeUserNames: true },
        { responseType: 'blob' }
      )
    );
  });

  it('confirms cancelling a background export in a danger ActionDialog before the DELETE', async () => {
    const job = { id: 'job-1', channelId: 'C0123', format: 'json', status: 'processing', progress: 40 };
    routeGets(WORKSPACES, { ...job, currentStep: 'Fetching messages', createdAt: '2026-01-05T00:00:00.000Z' });
    mocks.post.mockResolvedValue({ data: { jobId: 'job-1' } });
    mocks.delete.mockResolvedValue({ data: {} });
    const { unmount } = renderTab();
    await loaded();

    fireEvent.click(screen.getByTestId('slack-workspace-export-btn-T1'));
    await screen.findByTestId('slack-export-dialog');
    fireEvent.click(within(screen.getByTestId('slack-export-async-toggle')).getByRole('switch'));
    fireEvent.change(screen.getByTestId('slack-export-channel-id-input'), { target: { value: 'C0123' } });
    fireEvent.click(screen.getByTestId('slack-export-confirm-btn'));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/slack/export/async', expect.anything()));
    expect(await screen.findByTestId('slack-export-job-status')).toHaveTextContent('Exporting...');

    fireEvent.click(screen.getByTestId('slack-export-cancel-async-btn'));
    const dialog = await screen.findByTestId('slack-export-cancel-job-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Cancel export');
    expect(mocks.delete).not.toHaveBeenCalled();
    pickReason('slack-export-cancel-job-dialog');
    fireEvent.click(screen.getByTestId('slack-export-cancel-job-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/slack/export/status/job-1'));
    await waitFor(() => expect(screen.queryByTestId('slack-export-cancel-job-dialog')).toBeNull());
    expect(screen.getByTestId('slack-export-job-status')).toHaveTextContent('Export cancelled');
    unmount();
  });

  it('reviews a manifest update in an AdminDialog and posts the same payload', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    renderTab();
    await loaded();

    fireEvent.click(await screen.findByTestId('manifest-update-btn-ws-old'));
    const dialog = await screen.findByTestId('manifest-update-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Update manifest');
    expect(within(dialog).getByTestId('manifest-update-diff')).toHaveTextContent('oauth_config.scopes.bot');
    expect(mocks.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('manifest-update-confirm-btn'));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/slack-app/update-manifest', { workspaceId: 'ws-old' })
    );
  });

  it('stores a configuration token from an AdminDialog with the same payload', async () => {
    mocks.post.mockResolvedValue({ data: {} });
    renderTab();
    await loaded();

    fireEvent.click(await screen.findByTestId('manifest-reconnect-btn-ws-token'));
    const dialog = await screen.findByTestId('reconnect-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Reconnect configuration token');
    expect(screen.getByTestId('reconnect-confirm-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('reconnect-token-input'), { target: { value: 'xoxe-test-token' } });
    fireEvent.click(screen.getByTestId('reconnect-confirm-btn'));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/slack-app/reconnect', {
        workspaceId: 'ws-token',
        configToken: 'xoxe-test-token',
      })
    );
  });
});
