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
    source: 'chat',
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
  });

  it('filters the ledger by type on the server and loads older pages', () => {
    const fetchNextPage = vi.fn();
    mocks.ledger.mockReturnValue(ledgerResult({ fetchNextPage }));
    renderTab();

    expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', undefined);
    fireEvent.click(screen.getByTestId('user-credits-more-btn'));
    expect(fetchNextPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('user-credits-filter-api'));
    expect(mocks.ledger).toHaveBeenLastCalledWith('test-user-1', 'api');
  });

  it('shows the ledger error and empty states', () => {
    mocks.ledger.mockReturnValue(
      ledgerResult({ data: { pages: [{ rows: [], nextCursor: null }] }, hasNextPage: false })
    );
    const { unmount } = renderTab();
    expect(screen.getByText('No credit transactions yet.')).toBeInTheDocument();
    unmount();

    mocks.ledger.mockReturnValue(ledgerResult({ data: undefined, isError: true }));
    renderTab();
    expect(screen.getByText('The ledger could not be loaded.')).toBeInTheDocument();
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

    await waitFor(() => expect(mocks.exportCsv).toHaveBeenCalledWith('test-user-1', 'purchase'));
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
});
