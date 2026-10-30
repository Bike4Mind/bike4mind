import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminCreditSummary, AdminLedgerRow } from '@bike4mind/common';
import { ProfileTestWrapper, buildProfile } from '../../profileTestUtils';
import { CreditsTab } from './CreditsTab';

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  ledger: vi.fn(),
  exportCsv: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/data/adminUserCredits', () => ({
  useAdminCreditSummary: mocks.summary,
  useAdminCreditLedger: mocks.ledger,
  fetchCreditLedgerExport: mocks.exportCsv,
}));
vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning, error: mocks.toastError } }));
// recharts needs layout jsdom does not have; the stub exposes what the chart was given.
vi.mock('./SpendChart', () => ({
  SpendChart: ({ points }: { points: { date: string; credits: number }[] }) => (
    <div data-testid="user-credits-chart" data-days={points.length} />
  ),
  SpendBreakdownChart: ({ bars }: { bars: { label: string; credits: number }[] }) => (
    <div data-testid="user-credits-breakdown-chart">{bars.map(bar => `${bar.label}=${bar.credits}`).join(';')}</div>
  ),
}));

const daily = (credits: (day: number) => number): AdminCreditSummary['daily'] =>
  Array.from({ length: 90 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 6, 30 + index)).toISOString().slice(0, 10),
    credits: credits(index),
  }));

const SUMMARY: AdminCreditSummary = {
  balance: 12450,
  spent: { last24h: 412, last7d: 2100, last30d: 9000 },
  topModel30d: { model: 'claude-sonnet-5-5', credits: 6200 },
  lastTopUp: { at: '2026-10-15T00:00:00Z', credits: 10000, type: 'subscription' },
  // 10 credits a day for the oldest 60 days, 100 a day for the newest 30.
  daily: daily(index => (index >= 60 ? 100 : 10)),
  byModel: [
    { key: 'claude-sonnet-5-5', last7d: 500, last30d: 2500, last90d: 2800 },
    { key: 'gpt-x', last7d: 200, last30d: 500, last90d: 800 },
  ],
  bySource: [
    { key: 'web', last7d: 600, last30d: 2600, last90d: 3000 },
    { key: null, last7d: 100, last30d: 400, last90d: 600 },
  ],
  systemCost: { todayUsd: 0.0425, last7dUsd: 0.5, last30dUsd: 1.25, dailyCapUsd: 0.1 },
};

const ROWS: AdminLedgerRow[] = [
  {
    id: 'tx-1',
    type: 'text_generation_usage',
    kind: 'usage',
    createdAt: '2026-10-27T10:00:00Z',
    credits: -412,
    balanceAfter: 12450,
    model: 'claude-sonnet-5-5',
    source: 'web',
    questId: 'quest-123',
    description: 'Chat reply',
  },
  {
    id: 'tx-2',
    type: 'generic_add',
    kind: 'adjustment',
    createdAt: '2026-10-20T10:00:00Z',
    credits: 2000,
    balanceAfter: 12862,
    reason: 'admin_adjustment',
    note: 'Goodwill credit',
    actorId: 'admin-1',
    actorName: 'Support Admin',
  },
];

const summaryResult = (overrides: Record<string, unknown> = {}) => ({
  data: SUMMARY,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  ...overrides,
});

const ledgerResult = (overrides: Record<string, unknown> = {}) => ({
  data: { pages: [{ rows: ROWS, nextCursor: 'next' }] },
  isLoading: false,
  isError: false,
  hasNextPage: true,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  ...overrides,
});

const renderTab = (onAdjust = vi.fn()) =>
  render(<CreditsTab user={buildProfile({ currentCredits: 12450 })} onAdjust={onAdjust} />, {
    wrapper: ProfileTestWrapper,
  });

describe('CreditsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summary.mockReturnValue(summaryResult());
    mocks.ledger.mockReturnValue(ledgerResult());
  });

  it('summarizes balance, spend, top model and last top-up', () => {
    renderTab();

    const strip = screen.getByRole('region', { name: 'Credit summary' });
    expect(strip).toHaveTextContent('12,450');
    expect(strip).toHaveTextContent('2,100');
    expect(strip).toHaveTextContent('9,000');
    expect(strip).toHaveTextContent('claude-sonnet-5-5');
    expect(strip).toHaveTextContent('+10,000');
    expect(strip).toHaveTextContent('Plan renewal');
    expect(screen.getByTestId('user-credits-total-24h')).toHaveTextContent('412 in the last 24 hours');
  });

  it('shows system-sourced provider cost next to credit spend', () => {
    renderTab();

    expect(screen.getByTestId('user-credits-system-cost-today')).toHaveTextContent('$0.0425');
    expect(screen.getByTestId('user-credits-system-cost-7d')).toHaveTextContent('$0.50');
    expect(screen.getByTestId('user-credits-system-cost-30d')).toHaveTextContent('$1.25');
    expect(screen.getByTestId('user-credits-system-cost-cap')).toHaveTextContent('$0.10');
    expect(screen.getByTestId('user-credits-system-cost')).not.toHaveTextContent('Daily cap reached');
  });

  it('flags a reached system cost cap and shows an unset cap as off', () => {
    mocks.summary.mockReturnValue(
      summaryResult({ data: { ...SUMMARY, systemCost: { ...SUMMARY.systemCost, todayUsd: 0.1 } } })
    );
    const { unmount } = renderTab();
    expect(screen.getByTestId('user-credits-system-cost')).toHaveTextContent('Daily cap reached');
    unmount();

    mocks.summary.mockReturnValue(
      summaryResult({ data: { ...SUMMARY, systemCost: { ...SUMMARY.systemCost, todayUsd: 5, dailyCapUsd: 0 } } })
    );
    renderTab();
    expect(screen.getByTestId('user-credits-system-cost-cap')).toHaveTextContent('Off');
    expect(screen.getByTestId('user-credits-system-cost')).not.toHaveTextContent('Daily cap reached');
  });

  it('shows dashes for system cost while the summary is unavailable', () => {
    mocks.summary.mockReturnValue(summaryResult({ data: undefined, isLoading: true }));
    renderTab();
    expect(screen.getByTestId('user-credits-system-cost-today')).toHaveTextContent('-');
    expect(screen.getByTestId('user-credits-system-cost-cap')).toHaveTextContent('-');
  });

  it('charts the chosen range: 30 days by default, then 7 and 90', () => {
    renderTab();

    expect(screen.getByTestId('user-credits-chart')).toHaveAttribute('data-days', '30');
    expect(screen.getByTestId('user-credits-chart-total')).toHaveTextContent('3,000 credits over 30 days');

    fireEvent.click(screen.getByTestId('user-credits-range-7'));
    expect(screen.getByTestId('user-credits-chart')).toHaveAttribute('data-days', '7');
    expect(screen.getByTestId('user-credits-chart-total')).toHaveTextContent('700 credits over 7 days');

    fireEvent.click(screen.getByTestId('user-credits-range-90'));
    expect(screen.getByTestId('user-credits-chart-total')).toHaveTextContent('3,600 credits over 90 days');
  });

  it('shows an empty chart state when the range has no spend', () => {
    mocks.summary.mockReturnValue(summaryResult({ data: { ...SUMMARY, daily: daily(() => 0) } }));
    renderTab();

    expect(screen.queryByTestId('user-credits-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-credits-chart-empty')).toHaveTextContent('No AI spend in the last 30 days.');
  });

  it('keeps the strip readable and offers a retry while the summary fails', () => {
    const refetch = vi.fn();
    mocks.summary.mockReturnValue(summaryResult({ data: undefined, isError: true, refetch }));
    renderTab();

    expect(screen.getByRole('region', { name: 'Credit summary' })).toHaveTextContent('12,450');
    expect(screen.getByText('Spend could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders ledger rows with type, signed change, balance, model and the admin who adjusted', () => {
    renderTab();

    const table = screen.getByTestId('user-credits-table');
    expect(within(table).getByText('Usage')).toBeInTheDocument();
    expect(within(table).getByText('−412')).toBeInTheDocument();
    expect(within(table).getByText('12,450')).toBeInTheDocument();
    expect(within(table).getByText('Admin')).toBeInTheDocument();
    expect(within(table).getByText('+2,000')).toBeInTheDocument();
    expect(within(table).getByText('Goodwill credit · by Support Admin')).toBeInTheDocument();
    expect(within(table).getByText('quest-123')).toBeInTheDocument();
  });

  it('filters the ledger by type on the server and loads older pages', () => {
    const fetchNextPage = vi.fn();
    mocks.ledger.mockReturnValue(ledgerResult({ fetchNextPage }));
    renderTab();

    expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', {}, { enabled: true });
    fireEvent.click(screen.getByTestId('user-credits-more-btn'));
    expect(fetchNextPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('user-credits-filter-api'));
    expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', { kind: 'api' }, { enabled: true });
  });

  it('shows the ledger error and empty states', () => {
    mocks.ledger.mockReturnValue(
      ledgerResult({ data: { pages: [{ rows: [], nextCursor: null }] }, hasNextPage: false })
    );
    const { unmount } = renderTab();
    expect(screen.getByText('No credit transactions yet.')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    mocks.ledger.mockReturnValue(ledgerResult({ data: undefined, isError: true, refetch }));
    renderTab();
    expect(screen.getByText('The ledger could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders a sparse API row with its request id and dashes for the missing detail and balance', () => {
    mocks.summary.mockReturnValue(
      summaryResult({ data: { ...SUMMARY, byModel: [{ key: null, last7d: 1, last30d: 1, last90d: 1 }] } })
    );
    mocks.ledger.mockReturnValue(
      ledgerResult({
        data: {
          pages: [
            {
              rows: [
                {
                  id: 'tx-3',
                  type: 'text_generation_usage',
                  kind: 'usage',
                  createdAt: '2026-10-27T11:00:00Z',
                  credits: -3,
                  requestId: 'req-abc',
                },
              ],
              nextCursor: null,
            },
          ],
        },
        hasNextPage: false,
      })
    );
    render(<CreditsTab user={buildProfile({ currentCredits: undefined })} onAdjust={vi.fn()} />, {
      wrapper: ProfileTestWrapper,
    });

    const row = screen.getByTestId('admin-table-row-tx-3');
    expect(row).toHaveTextContent('req-abc');
    expect(row).not.toHaveTextContent('undefined');
  });

  it('sorts the loaded ledger rows by time and by change', () => {
    renderTab();
    const rowIds = () =>
      within(screen.getByTestId('user-credits-ledger'))
        .getAllByTestId(/^admin-table-row-/)
        .map(row => row.dataset.testid);

    fireEvent.click(screen.getByTestId('admin-table-sort-when-btn'));
    const byWhen = rowIds();
    fireEvent.click(screen.getByTestId('admin-table-sort-when-btn'));
    expect(rowIds()).toEqual([...byWhen].reverse());

    fireEvent.click(screen.getByTestId('admin-table-sort-change-btn'));
    const byChange = rowIds();
    fireEvent.click(screen.getByTestId('admin-table-sort-change-btn'));
    expect(rowIds()).toEqual([...byChange].reverse());
  });

  it('reports a failed export', async () => {
    mocks.exportCsv.mockRejectedValue(new Error('network'));
    renderTab();

    fireEvent.click(screen.getByTestId('user-credits-export-btn'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The export failed. Try again.'));
    expect(screen.getByTestId('user-credits-export-btn')).not.toBeDisabled();
  });

  it('exports the current filter and states the row cap', async () => {
    mocks.exportCsv.mockResolvedValue({ blob: new Blob(['a']), fileName: 'credits.csv', truncated: false });
    const createObjectURL = vi.fn(() => 'blob:url');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    renderTab();

    expect(screen.getByTestId('user-credits-export-cap')).toHaveTextContent('up to 10,000 rows');
    fireEvent.click(screen.getByTestId('user-credits-filter-purchase'));
    fireEvent.click(screen.getByTestId('user-credits-export-btn'));

    await waitFor(() => expect(mocks.exportCsv).toHaveBeenCalledWith('test-user-1', { kind: 'purchase' }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:url'));
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });

  it('warns when the export hit the cap', async () => {
    mocks.exportCsv.mockResolvedValue({ blob: new Blob(['a']), fileName: 'credits.csv', truncated: true });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:url'), revokeObjectURL: vi.fn() });
    renderTab();

    fireEvent.click(screen.getByTestId('user-credits-export-btn'));

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        'The export stopped at 10,000 rows. Narrow the filter to get the rest.'
      )
    );
  });

  it('opens the shared Adjust credits dialog through the profile', () => {
    const onAdjust = vi.fn();
    renderTab(onAdjust);

    fireEvent.click(screen.getByTestId('user-profile-credits-adjust-btn'));
    expect(onAdjust).toHaveBeenCalledOnce();
  });

  it('switches the spend chart to by model and by source over the same range and total', () => {
    renderTab();

    fireEvent.click(screen.getByTestId('user-credits-view-model'));
    expect(screen.queryByTestId('user-credits-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-credits-breakdown-chart')).toHaveTextContent('claude-sonnet-5-5=2500;gpt-x=500');
    expect(screen.getByTestId('user-credits-chart-total')).toHaveTextContent('3,000 credits over 30 days');

    fireEvent.click(screen.getByTestId('user-credits-range-7'));
    expect(screen.getByTestId('user-credits-breakdown-chart')).toHaveTextContent('claude-sonnet-5-5=500;gpt-x=200');

    fireEvent.click(screen.getByTestId('user-credits-view-source'));
    expect(screen.getByTestId('user-credits-breakdown-chart')).toHaveTextContent('Web=600;Unclassified=100');

    fireEvent.click(screen.getByTestId('user-credits-view-day'));
    expect(screen.getByTestId('user-credits-chart')).toHaveAttribute('data-days', '7');
  });

  it('narrows the ledger by model, source and date range, then clears every filter', async () => {
    renderTab();

    const model = screen.getByTestId('user-credits-model-filter');
    fireEvent.change(model, { target: { value: 'gpt-x' } });
    fireEvent.keyDown(model, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', { model: 'gpt-x' }, { enabled: true })
    );

    fireEvent.click(screen.getByTestId('user-credits-source-filter'));
    fireEvent.click(await screen.findByTestId('user-credits-source-option-cli'));
    await waitFor(() =>
      expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', { model: 'gpt-x', source: 'cli' }, { enabled: true })
    );

    fireEvent.change(screen.getByTestId('user-credits-from'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByTestId('user-credits-to'), { target: { value: '2026-10-07' } });
    expect(mocks.ledger).toHaveBeenLastCalledWith(
      'test-user-1',
      { model: 'gpt-x', source: 'cli', from: '2026-10-01', to: '2026-10-07' },
      { enabled: true }
    );
    expect(
      screen.getByText('Balance shows on admin adjustments only while a type, model or source filter is on.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-credits-clear-filters-btn'));
    expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', {}, { enabled: true });
    expect(screen.queryByTestId('user-credits-clear-filters-btn')).not.toBeInTheDocument();
  });

  it('holds the ledger and the export while the date range is reversed', () => {
    mocks.ledger.mockReturnValue(ledgerResult({ data: undefined, hasNextPage: false }));
    renderTab();

    fireEvent.change(screen.getByTestId('user-credits-from'), { target: { value: '2026-10-07' } });
    fireEvent.change(screen.getByTestId('user-credits-to'), { target: { value: '2026-10-01' } });

    expect(mocks.ledger).toHaveBeenLastCalledWith(
      'test-user-1',
      { from: '2026-10-07', to: '2026-10-01' },
      { enabled: false }
    );
    expect(screen.getByText('The start date is after the end date.')).toBeInTheDocument();
    expect(screen.getByText('Fix the date range to see transactions.')).toBeInTheDocument();
    expect(screen.getByTestId('user-credits-export-btn')).toBeDisabled();
  });

  it('exports under the model, source and date filters too', async () => {
    mocks.exportCsv.mockResolvedValue({ blob: new Blob(['a']), fileName: 'credits.csv', truncated: false });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:url'), revokeObjectURL: vi.fn() });
    renderTab();

    fireEvent.change(screen.getByTestId('user-credits-from'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByTestId('user-credits-export-btn'));

    await waitFor(() => expect(mocks.exportCsv).toHaveBeenCalledWith('test-user-1', { from: '2026-10-01' }));
  });
});
