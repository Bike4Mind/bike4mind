import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  currentUser: { isAdmin: true, adminPermissions: [] } as { isAdmin: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.currentUser }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, warning: mocks.warning, error: mocks.error } }));

import AgentExecutionsTab from './AgentExecutionsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const MINUTE = 60_000;
const execution = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  userId: `user-${id}-0123456789abcdef`,
  sessionId: `session-${id}`,
  questId: `quest-${id}`,
  query: `Summarise the quarterly report for ${id}`,
  model: 'claude-test',
  status: 'running',
  totalCreditsUsed: 1.5,
  lambdaInvocationCount: 1,
  createdAt: new Date(Date.now() - 90 * MINUTE).toISOString(),
  updatedAt: new Date(Date.now() - 45 * MINUTE).toISOString(),
  ...overrides,
});

const ITEMS = [
  execution('exec-1', {
    confidenceTelemetry: { evaluatedCount: 4, emittedCount: 2, minConfidence: 0.31, avgConfidence: 0.62 },
  }),
  execution('exec-2', { status: 'pending' }),
  execution('exec-3', { status: 'paused' }),
];

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <AgentExecutionsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const lastGetParams = () => (mocks.get.mock.lastCall?.[1] as { params: Record<string, unknown> }).params;

const selectRow = (id: string) =>
  fireEvent.click(within(screen.getByTestId(`admin-table-select-${id}`)).getByRole('checkbox'));

const confirmRelease = async () => {
  fireEvent.click(screen.getByTestId('stuck-agent-executions-cleanup-btn'));
  const dialog = await screen.findByTestId('stuck-agent-executions-release-dialog');
  fireEvent.change(within(dialog).getByTestId('stuck-agent-executions-release-dialog-reason-input'), {
    target: { value: 'Abandoned by a user who left' },
  });
  fireEvent.click(within(dialog).getByTestId('stuck-agent-executions-release-dialog-confirm-btn'));
};

describe('AgentExecutionsTab', () => {
  beforeEach(() => {
    [mocks.get, mocks.post, mocks.success, mocks.warning, mocks.error].forEach(mock => mock.mockReset());
    mocks.currentUser = { isAdmin: true, adminPermissions: [] };
    mocks.get.mockResolvedValue({ data: { items: ITEMS, olderThanMinutes: 20 } });
    mocks.post.mockResolvedValue({ data: { requested: 1, marked: 1, notifiedConnections: 0, questsSettled: 0 } });
  });

  it('opens with the page header: a sentence-case h1 with no icon, the description and Refresh in the actions', async () => {
    renderTab();

    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('stuck-agent-executions-tab').firstElementChild).toBe(header);
    const title = within(header).getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent(/^Stuck executions$/);
    expect(title.querySelector('svg')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(header).toHaveTextContent('awaiting_subagent');
    expect(within(header).getByTestId('stuck-agent-executions-refresh-btn')).toHaveTextContent('Refresh');
    await screen.findByTestId('stuck-execution-row-exec-1');
  });

  it('lists executions in one DataTable that scrolls sideways below its min width, with no card around it', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    expect(screen.getByTestId('stuck-agent-executions-table')).toHaveStyle({ minWidth: '68rem' });
    expect(screen.getByTestId('stuck-agent-executions-table-frame')).toBeInTheDocument();
    expect(screen.getByTestId('stuck-agent-executions-tab').querySelectorAll('.MuiCard-root')).toHaveLength(0);
    expect(screen.getByTestId('stuck-execution-row-exec-3')).toHaveTextContent('paused');
  });

  it('shows each status and the gated count as warn status chips', async () => {
    renderTab();

    const status = await screen.findByTestId('stuck-execution-status-exec-2');
    expect(status).toHaveTextContent('pending');
    expect(status).toHaveAttribute('data-tone', 'warn');
    const confidence = screen.getByTestId('stuck-execution-confidence-exec-1');
    expect(confidence).toHaveTextContent('0.62 / 0.31');
    expect(within(confidence).getByTestId('admin-status-chip')).toHaveAttribute('data-tone', 'warn');
    expect(within(confidence).getByTestId('admin-status-chip')).toHaveTextContent('2 gated');
    expect(screen.getByTestId('stuck-execution-confidence-exec-2')).toHaveTextContent('-');
  });

  it('puts the filters in one row: user search first, then the status chip and the age threshold', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    const filters = screen.getByTestId('stuck-agent-executions-filters');
    expect(filters).toHaveStyle({ flexWrap: 'wrap' });
    const controls = within(filters).getAllByRole('textbox');
    expect(controls[0]).toBe(screen.getByTestId('stuck-agent-executions-user-id'));
    expect(within(filters).getByTestId('admin-filter-status')).toHaveTextContent('Status');
    expect(within(filters).getByTestId('stuck-agent-executions-minutes')).toHaveValue(20);
    expect(lastGetParams()).toEqual({ minutes: 20, limit: 200 });

    fireEvent.click(screen.getByTestId('admin-filter-status'));
    expect(screen.queryByTestId('admin-filter-status-awaiting_subagent')).toBeNull();
    fireEvent.click(await screen.findByTestId('admin-filter-status-paused'));
    await waitFor(() => expect(lastGetParams()).toEqual({ minutes: 20, status: 'paused', limit: 200 }));

    fireEvent.change(screen.getByTestId('stuck-agent-executions-minutes'), { target: { value: '45' } });
    await waitFor(() => expect(lastGetParams()).toEqual({ minutes: 45, status: 'paused', limit: 200 }));
  });

  it('confirms the release in a dialog, then posts exactly the selected ids', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
    selectRow('exec-1');
    selectRow('exec-3');
    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('2 selected');

    fireEvent.click(screen.getByTestId('stuck-agent-executions-cleanup-btn'));
    const dialog = await screen.findByTestId('stuck-agent-executions-release-dialog');
    expect(within(dialog).getByTestId('stuck-agent-executions-release-summary')).toHaveTextContent(
      '2 selected: 1 running, 1 paused'
    );
    expect(mocks.post).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByTestId('stuck-agent-executions-release-dialog-reason-input'), {
      target: { value: 'Abandoned by a user who left' },
    });
    fireEvent.click(within(dialog).getByTestId('stuck-agent-executions-release-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/agent-executions/cleanup', {
      executionIds: ['exec-1', 'exec-3'],
    });
    await waitFor(() => expect(screen.queryByTestId('stuck-agent-executions-release-dialog')).toBeNull());
    expect(mocks.success).toHaveBeenCalledWith('Marked 1 abandoned (0 live connections notified)');
    expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
  });

  it('releases every listed execution after Select all matching', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    selectRow('exec-2');
    fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
    await confirmRelease();

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toEqual({ executionIds: ['exec-1', 'exec-2', 'exec-3'] });
  });

  it('keeps the dialog open and posts nothing more when the release fails', async () => {
    mocks.post.mockRejectedValueOnce(new Error('boom'));
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    selectRow('exec-1');
    await confirmRelease();

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Cleanup failed: boom'));
    expect(screen.getByTestId('stuck-agent-executions-release-dialog')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('blocks release when the last refresh failed', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');
    selectRow('exec-1');

    mocks.get.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByTestId('stuck-agent-executions-refresh-btn'));
    await screen.findByTestId('stuck-agent-executions-refresh-error');

    fireEvent.click(screen.getByTestId('stuck-agent-executions-cleanup-btn'));
    const dialog = await screen.findByTestId('stuck-agent-executions-release-dialog');
    fireEvent.change(within(dialog).getByTestId('stuck-agent-executions-release-dialog-reason-input'), {
      target: { value: 'Abandoned by a user who left' },
    });
    expect(dialog).toHaveTextContent('The list could not be refreshed. Refresh it before releasing executions.');
    const confirm = within(dialog).getByTestId('stuck-agent-executions-release-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('drops the selection when a filter changes, so hidden rows are never released', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    selectRow('exec-1');
    expect(screen.getByTestId('admin-bulk-action-bar')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('stuck-agent-executions-minutes'), { target: { value: '30' } });

    await waitFor(() => expect(lastGetParams()).toEqual({ minutes: 30, limit: 200 }));
    await screen.findByTestId('stuck-execution-row-exec-1');
    expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
  });

  it('does not offer the previous filter rows for release while the next request is pending', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');
    selectRow('exec-1');

    const request = Promise.withResolvers<{ data: { items: typeof ITEMS; olderThanMinutes: number } }>();
    mocks.get.mockReturnValueOnce(request.promise);
    fireEvent.change(screen.getByTestId('stuck-agent-executions-minutes'), { target: { value: '60' } });

    await waitFor(() => expect(lastGetParams()).toEqual({ minutes: 60, limit: 200 }));
    expect(screen.queryByTestId('stuck-execution-row-exec-1')).toBeNull();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('stuck-agent-executions-empty')).toBeNull();
    expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();

    await act(async () => {
      request.resolve({ data: { items: [ITEMS[1]], olderThanMinutes: 60 } });
    });
    expect(await screen.findByTestId('stuck-execution-row-exec-2')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-bulk-action-bar')).toBeNull();
  });

  it('shows an EmptyState with a Refresh action when nothing is stuck', async () => {
    mocks.get.mockResolvedValue({ data: { items: [], olderThanMinutes: 20 } });
    renderTab();

    const empty = await screen.findByTestId('stuck-agent-executions-empty');
    expect(within(empty).getByTestId('admin-empty-state')).toHaveTextContent('No stuck executions');
    const calls = mocks.get.mock.calls.length;
    fireEvent.click(within(empty).getByTestId('stuck-agent-executions-empty-refresh-btn'));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(calls));
  });

  it('shows table skeleton rows on the first load, under the header', async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect((await screen.findAllByTestId('admin-table-skeleton-row')).length).toBeGreaterThan(0);
  });

  it('keeps skeleton rows, not the empty state, while the first request waits for the network', () => {
    onlineManager.setOnline(false);
    try {
      renderTab();

      expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
      expect(screen.queryByTestId('stuck-agent-executions-empty')).toBeNull();
      expect(mocks.get).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('shows an ErrorState with Try again when the first load fails', async () => {
    mocks.get.mockRejectedValueOnce(new Error('timeout'));
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Failed to load stuck executions: timeout');
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('stuck-execution-row-exec-1')).toBeInTheDocument();
  });

  it('keeps the rows on screen and shows the updating bar during a refetch', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByTestId('stuck-agent-executions-refresh-btn'));

    expect(await screen.findByTestId('stuck-agent-executions-updating')).toBeInTheDocument();
    expect(screen.getByTestId('stuck-execution-row-exec-1')).toBeInTheDocument();
  });

  it('counts and releases only selected rows that are still listed after a poll', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    selectRow('exec-1');
    selectRow('exec-3');
    mocks.get.mockResolvedValue({ data: { items: [ITEMS[0], ITEMS[1]], olderThanMinutes: 20 } });
    fireEvent.click(screen.getByTestId('stuck-agent-executions-refresh-btn'));
    await waitFor(() => expect(screen.queryByTestId('stuck-execution-row-exec-3')).toBeNull());

    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('1 selected');
    fireEvent.click(screen.getByTestId('stuck-agent-executions-cleanup-btn'));
    const dialog = await screen.findByTestId('stuck-agent-executions-release-dialog');
    expect(within(dialog).getByTestId('stuck-agent-executions-release-summary')).toHaveTextContent(
      '1 selected: 1 running'
    );
    fireEvent.change(within(dialog).getByTestId('stuck-agent-executions-release-dialog-reason-input'), {
      target: { value: 'Abandoned by a user who left' },
    });
    fireEvent.click(within(dialog).getByTestId('stuck-agent-executions-release-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0][1]).toEqual({ executionIds: ['exec-1'] });
  });

  it('blocks the open dialog and says why when a poll drops every selected row', async () => {
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');

    selectRow('exec-1');
    fireEvent.click(screen.getByTestId('stuck-agent-executions-cleanup-btn'));
    const dialog = await screen.findByTestId('stuck-agent-executions-release-dialog');
    fireEvent.change(within(dialog).getByTestId('stuck-agent-executions-release-dialog-reason-input'), {
      target: { value: 'Abandoned by a user who left' },
    });

    mocks.get.mockResolvedValue({ data: { items: [ITEMS[1], ITEMS[2]], olderThanMinutes: 20 } });
    fireEvent.click(screen.getByTestId('stuck-agent-executions-refresh-btn'));
    await waitFor(() => expect(screen.queryByTestId('stuck-execution-row-exec-1')).toBeNull());

    expect(within(dialog).getByTestId('stuck-agent-executions-release-dialog-hint')).toHaveTextContent(
      'The selected executions are no longer listed.'
    );
    const confirm = within(dialog).getByTestId('stuck-agent-executions-release-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('stuck-agent-executions-release-dialog')).toBeInTheDocument();
  });
});

describe('AgentExecutionsTab cleanup permission', () => {
  beforeEach(() => {
    [mocks.get, mocks.post].forEach(mock => mock.mockReset());
    mocks.get.mockResolvedValue({ data: { items: ITEMS, olderThanMinutes: 20 } });
  });

  const renderSelected = async (user: typeof mocks.currentUser) => {
    mocks.currentUser = user;
    renderTab();
    await screen.findByTestId('stuck-execution-row-exec-1');
    selectRow('exec-1');
    return screen.getByTestId('stuck-agent-executions-cleanup-btn') as HTMLButtonElement;
  };

  it('is disabled with the missing-permission hint for a support:read delegate', async () => {
    const button = await renderSelected({ isAdmin: false, adminPermissions: ['support:read'] });

    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('admin-missing-permission-action')).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByTestId('stuck-agent-executions-release-dialog')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('is enabled for a settings:manage delegate', async () => {
    const button = await renderSelected({ isAdmin: false, adminPermissions: ['settings:manage'] });

    expect(button.disabled).toBe(false);
    expect(screen.queryByTestId('admin-missing-permission-action')).toBeNull();
  });
});
