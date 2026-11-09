import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type AxiosResponse } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  useWebhookAuditLog: vi.fn(),
  useWebhookAuditLogs: vi.fn(),
  useWebhookAuditStats: vi.fn(),
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/data/webhookAuditLogs', () => ({
  useWebhookAuditLogs: mocks.useWebhookAuditLogs,
  useWebhookAuditStats: mocks.useWebhookAuditStats,
  useWebhookAuditLog: mocks.useWebhookAuditLog,
  getDateRangePreset: () => ({ startDate: '2026-10-14T00:00:00.000Z', endDate: '2026-10-21T00:00:00.000Z' }),
}));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import WebhookAuditLogsTab from './index';

const DELIVERY_ID = '8f1c2e40-1d2b-11ef-9a3c-5b1e2d3c4f5a';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <WebhookAuditLogsTab />
    </CssVarsProvider>
  );

// Joy unmounts a closed modal, so a dialog that is in the document is open.
const isDialogOpen = () => {
  const dialog = screen.queryByTestId('webhook-details-dialog');
  return dialog !== null && dialog.getAttribute('aria-hidden') !== 'true';
};

const notFound = () =>
  new AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined, { status: 404 } as AxiosResponse);

const logsResult = (overrides: Record<string, unknown> = {}) => ({
  data: { pages: [{ logs: [] }] },
  isLoading: false,
  isFetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: mocks.fetchNextPage,
  refetch: mocks.refetch,
  error: null,
  isError: false,
  ...overrides,
});

const delivery = (deliveryId: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id: `log-${deliveryId}`,
  deliveryId,
  correlationId: `corr-${deliveryId}`,
  event: 'pull_request',
  repository: 'acme/widgets',
  sender: 'octocat',
  organizationId: 'org-1',
  receivedAt: '2026-10-20T10:00:00.000Z',
  processingDurationMs: 1250,
  status,
  signatureVerified: true,
  actions: [],
  metadata: {},
  ...overrides,
});

const LOGS = [
  delivery('d-completed', 'completed'),
  delivery('d-failed', 'failed'),
  delivery('d-processing', 'processing'),
  delivery('d-received', 'received'),
];

const STATS = {
  totalDeliveries: 1200,
  successRate: 80.5,
  avgProcessingDurationMs: 120.4,
  p95ProcessingDurationMs: 400,
  failureCount: 7,
};

const precedes = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Total rem width of the header cells that set a fixed width; the rest is the table's auto column. */
const fixedColumnsRem = (table: HTMLElement) =>
  Array.from(table.querySelectorAll<HTMLElement>('thead th')).reduce(
    (sum, cell) => (cell.style.width.endsWith('rem') ? sum + parseFloat(cell.style.width) : sum),
    0
  );

beforeEach(() => {
  mocks.useWebhookAuditLog.mockReset();
  mocks.useWebhookAuditLog.mockReturnValue({ data: undefined, isLoading: true, error: null });
  mocks.useWebhookAuditLogs.mockReset();
  mocks.useWebhookAuditLogs.mockReturnValue(logsResult());
  mocks.useWebhookAuditStats.mockReset();
  mocks.useWebhookAuditStats.mockReturnValue({ data: undefined, isLoading: false, error: null, isError: false });
  mocks.refetch.mockReset();
  mocks.fetchNextPage.mockReset();
  act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs' }));
});

describe('WebhookAuditLogsTab delivery dialog', () => {
  it('opens the delivery a link names and closes it by removing the param', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    await waitFor(() => expect(isDialogOpen()).toBe(true));
    expect(mocks.useWebhookAuditLog).toHaveBeenLastCalledWith(DELIVERY_ID);

    await userEvent.click(screen.getByTestId('webhook-details-dialog-close-btn'));

    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' });
    await waitFor(() => expect(isDialogOpen()).toBe(false));
  });

  it('closes cleanly when the linked delivery does not exist', async () => {
    mocks.useWebhookAuditLog.mockImplementation((deliveryId: string | null) =>
      deliveryId
        ? { data: undefined, isLoading: false, error: notFound() }
        : { data: undefined, isLoading: false, error: null }
    );
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    await waitFor(() => expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' }));
    expect(isDialogOpen()).toBe(false);
  });

  it('keeps the dialog open with a retry on an error that is not a missing delivery', async () => {
    const refetchDelivery = vi.fn();
    mocks.useWebhookAuditLog.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('network'),
      refetch: refetchDelivery,
    });
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    await waitFor(() => expect(isDialogOpen()).toBe(true));
    expect(fakeAdminRouter.search).toMatchObject({ webhookDeliveryId: DELIVERY_ID });
    const dialog = screen.getByTestId('webhook-details-dialog');
    fireEvent.click(within(dialog).getByTestId('admin-error-retry-btn'));
    expect(refetchDelivery).toHaveBeenCalledTimes(1);
  });

  it('never opens a dialog for a malformed id', () => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: '../users' }));
    renderTab();

    expect(isDialogOpen()).toBe(false);
    expect(mocks.useWebhookAuditLog).toHaveBeenLastCalledWith(null);
  });

  it('lays the delivery out as titled fact groups split by hairlines, with toned status chips', async () => {
    mocks.useWebhookAuditLog.mockReturnValue({
      data: delivery(DELIVERY_ID, 'failed', {
        metadata: { prNumber: 42, branch: 'main' },
        actions: [
          { type: 'triage', status: 'failed', durationMs: 30 },
          { type: 'comment', status: 'success' },
        ],
        error: { message: 'Boom', code: 'E_TRIAGE' },
        processedAt: '2026-10-20T10:00:02.000Z',
      }),
      isLoading: false,
      error: null,
    });
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    const dialog = await screen.findByTestId('webhook-details-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Webhook delivery');
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map(heading => heading.textContent)
    ).toEqual(['Status', 'Identity', 'Event', 'Metadata', 'Actions', 'Error', 'Timeline']);
    const details = within(dialog).getByTestId('webhook-details');
    expect(details.querySelectorAll('section > dl')).toHaveLength(6);
    expect(within(details).getAllByTestId('webhook-logs-status-chip')[0]).toHaveAttribute('data-tone', 'bad');
    expect(within(details).getByTestId('webhook-details-signature-chip')).toHaveAttribute('data-tone', 'good');
    expect(
      within(details)
        .getAllByTestId('admin-status-chip')
        .map(chip => [chip.textContent, chip.getAttribute('data-tone')])
    ).toEqual([
      ['failed', 'bad'],
      ['success', 'good'],
    ]);
    expect(within(details).getByTestId('webhook-details-error')).toHaveTextContent('Boom');
    expect(details).toHaveTextContent('#42');
  });
});

describe('WebhookAuditLogsTab page anatomy', () => {
  it('opens with the page header, titled like its sidebar item, and keeps Refresh in it', () => {
    renderTab();
    const tab = screen.getByTestId('webhook-audit-logs-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Webhook audit logs');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    fireEvent.click(within(header).getByTestId('webhook-logs-refresh-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the key numbers in one strip with neutral ink values, even for failures', () => {
    mocks.useWebhookAuditStats.mockReturnValue({ data: STATS, isLoading: false, error: null, isError: false });
    renderTab();
    const strip = screen.getByTestId('admin-stat-strip');
    const tiles = within(strip).getAllByTestId('admin-stat-tile');
    expect(tiles.map(tile => tile.textContent)).toEqual([
      'Total deliveries1,200Last 7 days',
      'Success rate80.5%',
      'Avg duration120msP95: 400ms',
      'Failures7',
    ]);
    for (const value of ['80.5%', '7']) {
      expect(getComputedStyle(within(strip).getByText(value)).color).toBe('var(--joy-palette-admin-ink)');
    }
    expect(precedes(screen.getByTestId('admin-page-header'), strip)).toBe(true);
  });

  it('shows a failed stats load as an error with Try again in place of the strip', () => {
    const refetchStats = vi.fn();
    mocks.useWebhookAuditStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Stats unavailable'),
      isError: true,
      refetch: refetchStats,
    });
    renderTab();
    expect(screen.queryByTestId('admin-stat-strip')).toBeNull();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Statistics failed to load: Stats unavailable');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetchStats).toHaveBeenCalledTimes(1);
  });

  it('puts search, range and filters in one row that wraps as a whole, with no labelled selects', () => {
    renderTab();
    const row = screen.getByTestId('webhook-logs-filter-row');
    expect(row).toHaveStyle({ display: 'flex', flexWrap: 'wrap' });
    expect(row.firstElementChild).toContainElement(screen.getByTestId('webhook-logs-repository-input'));
    expect(
      within(within(row).getByTestId('webhook-logs-range'))
        .getAllByRole('button')
        .map(segment => segment.textContent)
    ).toEqual(['24h', '7d', '30d', '90d']);
    expect(within(row).getByTestId('webhook-logs-range-7d')).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['webhook-source', 'webhook-event', 'webhook-status']) {
      expect(within(row).getByTestId(`admin-filter-${id}`)).toBeInTheDocument();
    }
    expect(within(row).queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByTestId('webhook-logs-clear-filters-btn')).toBeNull();
  });

  it('writes a picked range and filter to the URL and clears them all from the row', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('webhook-logs-range-30d'));
    fireEvent.click(screen.getByTestId('admin-filter-webhook-status'));
    fireEvent.click(screen.getByTestId('admin-filter-webhook-status-failed'));
    fireEvent.click(screen.getByTestId('admin-filter-webhook-source'));
    fireEvent.click(screen.getByTestId('admin-filter-webhook-source-org'));
    expect(fakeAdminRouter.search).toEqual({
      tab: 'webhook-audit-logs',
      webhookRange: '30d',
      webhookStatus: 'failed',
      webhookSource: 'org',
    });
    expect(screen.getByTestId('admin-filter-webhook-status')).toHaveTextContent('Status: Failed');

    fireEvent.click(screen.getByTestId('webhook-logs-clear-filters-btn'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs', webhookRange: '30d' });
  });
});

describe('WebhookAuditLogsTab delivery list', () => {
  it('lists deliveries in a DataTable with a toned status chip per row and opens one on click', () => {
    mocks.useWebhookAuditLogs.mockReturnValue(logsResult({ data: { pages: [{ logs: LOGS }] } }));
    renderTab();
    const table = screen.getByTestId('webhook-logs-table');
    expect(screen.getByTestId('webhook-logs-table-frame')).toContainElement(table);
    const tones = Object.fromEntries(
      LOGS.map(log => [
        log.status,
        within(screen.getByTestId(`webhook-logs-row-${log.deliveryId}`))
          .getByTestId('webhook-logs-status-chip')
          .getAttribute('data-tone'),
      ])
    );
    expect(tones).toEqual({ completed: 'good', failed: 'bad', processing: 'warn', received: 'warn' });

    fireEvent.click(within(screen.getByTestId('webhook-logs-row-d-failed')).getByText('acme/widgets'));
    expect(fakeAdminRouter.search).toMatchObject({ webhookDeliveryId: 'd-failed' });
  });

  it('leaves the repository column room below the table min width instead of crushing it', () => {
    mocks.useWebhookAuditLogs.mockReturnValue(logsResult({ data: { pages: [{ logs: LOGS }] } }));
    renderTab();
    const table = screen.getByTestId('webhook-logs-table');
    expect(parseFloat(getComputedStyle(table).minWidth) - fixedColumnsRem(table)).toBeGreaterThanOrEqual(12);
  });

  it('loads the next page from below the table, which grows with the page instead of scrolling inside', () => {
    mocks.useWebhookAuditLogs.mockReturnValue(logsResult({ data: { pages: [{ logs: LOGS }] }, hasNextPage: true }));
    renderTab();
    const loadMore = screen.getByTestId('webhook-logs-load-more-btn');
    const frame = screen.getByTestId('webhook-logs-table-frame');
    expect(precedes(frame, loadMore)).toBe(true);
    expect(['', 'none']).toContain(getComputedStyle(frame).maxHeight);
    fireEvent.click(loadMore);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('keeps rows on screen under the updating bar while it refetches', () => {
    mocks.useWebhookAuditLogs.mockReturnValue(logsResult({ data: { pages: [{ logs: LOGS }] }, isFetching: true }));
    renderTab();
    expect(screen.getByTestId('webhook-logs-updating')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-logs-row-d-completed')).toBeInTheDocument();
  });

  it('keeps the previous rows and totals under the updating bar while a filter loads, then swaps them', () => {
    const NEW_LOGS = [delivery('d-new', 'failed')];
    let filteredLoaded = false;
    // A filtered request is in flight until filteredLoaded: the hooks hand back the previous data as
    // placeholder, as keepPreviousData does in hooks/data/webhookAuditLogs.ts.
    mocks.useWebhookAuditLogs.mockImplementation((filters: { status?: string }) => {
      if (!filters.status) return logsResult({ data: { pages: [{ logs: LOGS }] }, hasNextPage: true });
      return filteredLoaded
        ? logsResult({ data: { pages: [{ logs: NEW_LOGS }] } })
        : logsResult({
            data: { pages: [{ logs: LOGS }] },
            hasNextPage: true,
            isFetching: true,
            isPlaceholderData: true,
          });
    });
    mocks.useWebhookAuditStats.mockImplementation((_range: unknown, filters: { status?: string }) => ({
      data: filters.status && filteredLoaded ? { ...STATS, totalDeliveries: 7 } : STATS,
      isLoading: false,
      isFetching: Boolean(filters.status) && !filteredLoaded,
      error: null,
      isError: false,
    }));
    const { rerender } = renderTab();
    expect(screen.queryByTestId('webhook-logs-updating')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-filter-webhook-status'));
    fireEvent.click(screen.getByTestId('admin-filter-webhook-status-failed'));
    expect(screen.getByTestId('webhook-logs-updating')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-logs-row-d-completed')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-skeleton-row')).toBeNull();
    expect(screen.queryByTestId('webhook-logs-stat-skeleton')).toBeNull();
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent('1,200');
    expect(screen.queryByTestId('webhook-logs-load-more-btn')).toBeNull();

    filteredLoaded = true;
    rerender(
      <CssVarsProvider theme={appTheme}>
        <WebhookAuditLogsTab />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('webhook-logs-updating')).toBeNull();
    expect(screen.queryByTestId('webhook-logs-row-d-completed')).toBeNull();
    expect(screen.getByTestId('webhook-logs-row-d-new')).toBeInTheDocument();
    expect(screen.getByTestId('admin-stat-strip')).toHaveTextContent('Total deliveries7');
  });

  it('offers a refresh when nothing arrived and a clear when filters match nothing', () => {
    const { unmount } = renderTab();
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No webhook deliveries');
    fireEvent.click(screen.getByTestId('webhook-logs-empty-refresh-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    unmount();

    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookEvent: 'push' }));
    renderTab();
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No deliveries match these filters');
    fireEvent.click(screen.getByTestId('webhook-logs-empty-clear-btn'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' });
  });

  it('shows a failed load as an error with Try again instead of an empty table', () => {
    mocks.useWebhookAuditLogs.mockReturnValue(
      logsResult({ data: undefined, isError: true, error: new Error('Request failed') })
    );
    renderTab();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Webhook logs failed to load: Request failed');
    expect(screen.queryByTestId('webhook-logs-table')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});
