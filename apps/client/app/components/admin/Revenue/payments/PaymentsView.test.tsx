import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminPaymentRow,
  AdminPaymentsListResponse,
  AdminPaymentsSummaryResponse,
  PaymentsCurrencyTotals,
  PaymentsPeriodSummary,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', async () => (await import('../../__tests__/fakeAdminRouter')).fakeRouterModule);

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
const downloadData = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/download', () => ({ downloadData }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// recharts needs layout jsdom does not have.
vi.mock('./PaymentsChart', () => ({
  PaymentsChart: ({ points }: { points: { label: string }[] }) => (
    <div data-testid="admin-payments-chart">{points.map(point => point.label).join(',')}</div>
  ),
}));
vi.mock('../MrrTrendChart', () => ({ MrrTrendChart: () => <div data-testid="admin-revenue-chart" /> }));
vi.mock('../RevenueCharts', () => ({
  MrrMovementChart: () => <div />,
  MrrByPlanChart: () => <div />,
  PayingByOwnerChart: () => <div />,
  AtRiskChart: () => <div />,
}));

import { fakeAdminRouter } from '../../__tests__/fakeAdminRouter';
import AdminRevenue from '../index';
import { ADMIN_REVENUE_PATH } from '../useAdminRevenue';
import { ADMIN_PAYMENTS_EXPORT_PATH, ADMIN_PAYMENTS_PATH, ADMIN_PAYMENTS_SUMMARY_PATH } from './useAdminPayments';

const theme = extendTheme({ ...getThemeConfig() });

const usdTotals = (overrides: Partial<PaymentsCurrencyTotals> = {}): PaymentsCurrencyTotals => ({
  currency: 'usd',
  subscriptionGross: 50_000,
  subscriptionCount: 10,
  creditGross: 20_000,
  creditCount: 4,
  refunds: 1_000,
  disputeLosses: 200,
  net: 68_800,
  ...overrides,
});

const period = (overrides: Partial<PaymentsPeriodSummary> = {}): PaymentsPeriodSummary => ({
  from: '2026-10-13',
  to: '2026-11-11',
  totals: [usdTotals()],
  payers: { total: 12, subscriptionOnly: 8, creditOnly: 3, both: 1 },
  creditBuyers: { purchases: 4, buyers: 4, firstTime: 3, repeat: 1 },
  coverage: { recordedFrom: '2025-01-01T00:00:00.000Z', stripeEvents: 'complete' },
  ...overrides,
});

const paymentRow = (overrides: Partial<AdminPaymentRow> = {}): AdminPaymentRow => ({
  id: 'p1',
  kind: 'credit_purchase',
  status: 'succeeded',
  occurredAt: '2026-11-10T14:32:10.000Z',
  ownerType: 'user',
  ownerId: 'u1',
  owner: { kind: 'user', id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' },
  amount: 2_000,
  currency: 'usd',
  refundedAmount: null,
  credits: 20_000,
  paymentIntentId: 'pi_123',
  invoiceId: null,
  subscriptionId: null,
  ...overrides,
});

let summary: AdminPaymentsSummaryResponse;
let list: AdminPaymentsListResponse;

const renderTab = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<AdminRevenue />, { wrapper: Wrapper });
};

const tile = (label: string) =>
  screen.getAllByTestId('admin-stat-tile').find(element => element.textContent?.startsWith(label))!;

beforeEach(() => {
  apiGet.mockReset();
  downloadData.mockReset();
  summary = {
    current: period(),
    previous: period({ totals: [usdTotals({ subscriptionGross: 40_000, creditGross: 10_000, net: 50_000 })] }),
    bucket: 'day',
    series: [
      { date: '2026-11-09', currency: 'usd', subscription: 10_000, creditPurchase: 2_000 },
      { date: '2026-11-10', currency: 'usd', subscription: 0, creditPurchase: 4_000 },
    ],
    searchTruncated: false,
  };
  list = {
    payments: [
      paymentRow(),
      paymentRow({
        id: 'p2',
        kind: 'subscription',
        status: 'partially_refunded',
        ownerType: 'organization',
        ownerId: '64b7f0c2a1b2c3d4e5f60718',
        owner: { kind: 'organization', id: '64b7f0c2a1b2c3d4e5f60718', name: 'Acme' },
        amount: 9_900,
        refundedAmount: 900,
        credits: null,
        paymentIntentId: null,
        invoiceId: 'in_456',
        subscriptionId: 'sub_789',
      }),
      paymentRow({ id: 'p3', status: 'dispute_lost', owner: null, ownerId: 'gone1' }),
    ],
    total: 3,
    page: 1,
    totalPages: 1,
    searchTruncated: false,
  };
  apiGet.mockImplementation(async (path: string) => {
    // The Subscriptions view has its own suite (../index.test.tsx); here it only shows its error state.
    if (path === ADMIN_REVENUE_PATH) throw new Error('Revenue is not under test here');
    if (path === ADMIN_PAYMENTS_SUMMARY_PATH) return { data: summary };
    if (path === ADMIN_PAYMENTS_PATH) return { data: list };
    if (path === ADMIN_PAYMENTS_EXPORT_PATH)
      return { data: new Blob(['a,b\n']), headers: { 'content-disposition': 'attachment; filename="payments.csv"' } };
    throw new Error(`Unexpected GET ${path}`);
  });
  act(() => fakeAdminRouter.reset({ tab: 'revenue', revenueView: 'payments' }));
});

describe('Revenue > Payments', () => {
  it('switches between the Subscriptions and Payments views through the URL', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'revenue' }));
    renderTab();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Revenue & payments');
    expect(screen.getByTestId('admin-revenue-range')).toBeTruthy();
    expect(await screen.findByText('Could not load revenue.')).toBeTruthy();
    expect(screen.queryByTestId('admin-payments-view')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-revenue-view-payments-btn'));
    expect(fakeAdminRouter.search.revenueView).toBe('payments');
    expect(await screen.findByTestId('admin-payments-view')).toBeTruthy();
    expect(screen.queryByTestId('admin-revenue-range')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-revenue-view-subscriptions-btn'));
    expect(fakeAdminRouter.search.revenueView).toBeUndefined();
    expect(screen.getByTestId('admin-revenue-range')).toBeTruthy();
  });

  it('shows the totals with comparisons, breakdown and series for the default range', async () => {
    renderTab();
    await screen.findByTestId('admin-payments-row-p1');
    expect(apiGet).toHaveBeenCalledWith(ADMIN_PAYMENTS_SUMMARY_PATH, {
      params: expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    });
    await waitFor(() => expect(tile('Gross').textContent).toContain('$700'));
    expect(tile('Gross').textContent).toContain('+$200.00 vs previous period');
    expect(tile('Refunds & disputes').textContent).toContain('-$12');
    expect(tile('Net').textContent).toContain('$688');
    expect(tile('Paying customers').textContent).toContain('8 subscription only, 3 credit only, 1 both');
    expect(tile('Credit buyers').textContent).toContain('3 first-time, 1 repeat');
    const average = screen.getByTestId('admin-payments-breakdown-row-average-credit');
    expect(average.textContent).toContain('$50.00');
    expect(screen.getByTestId('admin-payments-breakdown-row-refunds').textContent).toContain('-$10.00');
    expect(screen.getByTestId('admin-payments-chart').textContent).toBe('Nov 9,Nov 10');
  });

  it('shows a dash, never $0, when subscription payments were not recorded', async () => {
    summary = {
      ...summary,
      current: period({
        totals: [usdTotals({ subscriptionGross: null, subscriptionCount: null, net: null })],
        coverage: { recordedFrom: null, stripeEvents: 'unavailable' },
      }),
    };
    renderTab();
    expect(await screen.findByTestId('admin-payments-net-unknown')).toBeTruthy();
    expect(screen.getByTestId('admin-payments-gross-unknown')).toBeTruthy();
    expect(tile('Net').textContent).not.toContain('$0');
    expect(screen.getByTestId('admin-payments-breakdown-row-subscriptions').textContent).not.toContain('$0.00');
    expect(screen.getByTestId('admin-payments-coverage-note').textContent).toContain('were not recorded');
  });

  it('notes when subscription payments are recorded from inside the range', async () => {
    summary = { ...summary, current: period({ coverage: { recordedFrom: '2026-11-01', stripeEvents: 'partial' } }) };
    renderTab();
    expect((await screen.findByTestId('admin-payments-coverage-note')).textContent).toBe(
      'Subscription payments, refunds and disputes are recorded from November 1, 2026. Earlier ones are not included.'
    );
  });

  it('labels each status and type, and shows refunds as negative money', async () => {
    renderTab();
    expect((await screen.findByTestId('admin-payments-status-p1')).textContent).toBe('Succeeded');
    expect(screen.getByTestId('admin-payments-status-p2').textContent).toBe('Partially refunded');
    expect(screen.getByTestId('admin-payments-status-p2').getAttribute('data-tone')).toBe('warn');
    expect(screen.getByTestId('admin-payments-status-p3').textContent).toBe('Dispute lost');
    expect(screen.getByTestId('admin-payments-status-p3').getAttribute('data-tone')).toBe('bad');
    expect(screen.getByTestId('admin-payments-type-p2').textContent).toBe('Subscription');
    const orgRow = screen.getByTestId('admin-payments-row-p2');
    expect(orgRow.textContent).toContain('-$9.00');
    expect(orgRow.textContent).toContain('Organization');
    expect(screen.getByTestId('admin-payments-row-p1').textContent).toContain('20,000');
    expect(screen.getByTestId('admin-payments-row-p3').textContent).toContain('Deleted customer');
  });

  it('opens a user payment on the user profile and an organization payment in Organizations', async () => {
    renderTab();
    const userRow = await screen.findByTestId('admin-payments-row-p1');
    fakeAdminRouter.navigate.mockImplementationOnce(() => undefined);
    fireEvent.click(userRow);
    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith({ to: '/admin/users/$userId', params: { userId: 'u1' } });

    fireEvent.click(screen.getByTestId('admin-payments-row-p2'));
    expect(fakeAdminRouter.search).toMatchObject({ tab: 'organizations', orgId: '64b7f0c2a1b2c3d4e5f60718' });
  });

  it('opens the subscription behind a subscription payment from the row menu', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-payments-row-actions-p2'));
    fakeAdminRouter.navigate.mockImplementationOnce(() => undefined);
    fireEvent.click(await screen.findByTestId('admin-payments-row-open-subscription-p2'));
    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith({
      to: '/admin/subscriptions/by-stripe/$stripeSubscriptionId',
      params: { stripeSubscriptionId: 'sub_789' },
    });
  });

  it('narrows by the URL filters and exports with the same filters', async () => {
    act(() =>
      fakeAdminRouter.reset({
        tab: 'revenue',
        revenueView: 'payments',
        payFrom: '2026-10-01',
        payTo: '2026-10-31',
        payKind: 'credit_purchase',
        payMin: 5,
      })
    );
    renderTab();
    await screen.findByTestId('admin-payments-row-p1');
    const expected = {
      from: '2026-10-01',
      to: '2026-10-31',
      kind: 'credit_purchase',
      minAmount: 500,
    };
    expect(apiGet).toHaveBeenCalledWith(ADMIN_PAYMENTS_PATH, {
      params: expect.objectContaining({ ...expected, page: 1, limit: 25 }),
    });
    expect(screen.getByTestId('admin-payments-totals-scope')).toBeTruthy();

    fireEvent.click(screen.getByTestId('admin-payments-export-btn'));
    await waitFor(() => expect(downloadData).toHaveBeenCalled());
    expect(apiGet).toHaveBeenCalledWith(ADMIN_PAYMENTS_EXPORT_PATH, {
      params: expect.objectContaining(expected),
      responseType: 'blob',
    });
    expect(downloadData.mock.calls[0][1]).toBe('payments.csv');
  });

  it('writes a picked filter to the URL and returns to the first page', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'revenue', revenueView: 'payments', payPage: 2 }));
    renderTab();
    await screen.findByTestId('admin-payments-row-p1');
    fireEvent.click(screen.getByTestId('admin-filter-payments-owner'));
    fireEvent.click(await screen.findByTestId('admin-filter-payments-owner-organization'));
    expect(fakeAdminRouter.search).toMatchObject({ payOwner: 'organization' });
    expect(fakeAdminRouter.search.payPage).toBeUndefined();
  });

  it('offers a wider range when the range is empty', async () => {
    list = { ...list, payments: [], total: 0 };
    renderTab();
    const empty = await screen.findByTestId('admin-empty-state');
    expect(within(empty).getByText('No payments in this range')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-payments-empty-widen-btn'));
    const { payFrom, payTo } = fakeAdminRouter.search as { payFrom: string; payTo: string };
    expect((Date.parse(payTo) - Date.parse(payFrom)) / 86_400_000).toBe(364);
  });

  it('offers to clear the filters when they match nothing', async () => {
    list = { ...list, payments: [], total: 0 };
    act(() => fakeAdminRouter.reset({ tab: 'revenue', revenueView: 'payments', payStatus: 'failed' }));
    renderTab();
    expect(await screen.findByText('No payments match these filters')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-payments-empty-clear-btn'));
    expect(fakeAdminRouter.search.payStatus).toBeUndefined();
  });

  it('asks to narrow a search that matched too many customers', async () => {
    list = { ...list, searchTruncated: true };
    renderTab();
    expect(await screen.findByTestId('admin-payments-search-truncated')).toBeTruthy();
  });
});
