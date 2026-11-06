import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminRevenueData, AdminRevenueResponse, RevenueTrendPoint } from '@client/app/utils/adminRevenue';
import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));
// recharts needs layout jsdom does not have; the stub exposes what the chart was given.
vi.mock('./MrrTrendChart', () => ({
  MrrTrendChart: ({ points }: { points: RevenueTrendPoint[] }) => (
    <div data-testid="admin-revenue-chart">{points.map(point => point.date).join(',')}</div>
  ),
}));
vi.mock('./RevenueCharts', () => ({
  MrrMovementChart: ({ periods }: { periods: { label: string }[] }) => (
    <div data-testid="admin-revenue-movement-chart">{periods.map(period => period.label).join(',')}</div>
  ),
  MrrByPlanChart: ({ series }: { series: { label: string }[] }) => (
    <div data-testid="admin-revenue-by-plan-chart">{series.map(entry => entry.label).join(',')}</div>
  ),
  PayingByOwnerChart: () => <div data-testid="admin-revenue-by-owner-chart" />,
  AtRiskChart: () => <div data-testid="admin-revenue-at-risk-chart" />,
}));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import AdminRevenue from './index';
import { trendTakeaway } from './revenueFormat';
import { ADMIN_REVENUE_PATH } from './useAdminRevenue';

const theme = extendTheme({ ...getThemeConfig() });

const usd = (amount: number, extra: { unpriced?: number; otherCurrency?: number } = {}) => ({
  currency: 'usd' as const,
  amount,
  unpriced: 0,
  otherCurrency: 0,
  ...extra,
});

const atRiskRow = (overrides: Partial<AdminSubscriptionRow>): AdminSubscriptionRow => ({
  id: 'r1',
  subscriptionId: 'sub_r1',
  ownerType: 'User',
  ownerId: 'u1',
  owner: {
    kind: 'User',
    id: 'u1',
    name: 'Ada Lovelace',
    username: 'ada',
    email: 'ada@example.com',
    stripeCustomerId: 'cus_1',
  },
  plan: { priceId: 'price_pro', name: 'Professional', interval: 'monthly' },
  billedInterval: { interval: 'month', intervalCount: 1 },
  status: 'past_due',
  source: 'stripe',
  quantity: 1,
  customCreditsPerCycle: null,
  mrr: { amount: 1900, currency: 'usd' },
  periodStartsAt: '2026-10-01T00:00:00.000Z',
  periodEndsAt: '2026-11-01T00:00:00.000Z',
  canceledAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const revenue = (overrides: Partial<AdminRevenueData> = {}): AdminRevenueData => ({
  stripeConfigured: true,
  range: '30d',
  from: '2026-10-01',
  to: '2026-10-30',
  current: {
    mrr: usd(1_234_500, { unpriced: 2 }),
    arr: 14_814_000,
    payingCount: 42,
    newMrr: usd(19_000),
    churnedMrr: usd(4_900),
    pastDueMrr: usd(1_900),
    cancelingMrr: usd(4_900),
  },
  startOfRange: null,
  trend: [],
  trendPlans: [],
  trendStartsOn: '2026-10-30',
  byPlan: [
    {
      plan: { priceId: 'price_team', name: 'Team', interval: 'monthly' },
      subscriptions: 30,
      mrr: usd(1_000_000),
      share: 0.81,
    },
    {
      plan: { priceId: 'price_legacy', name: null, interval: null },
      subscriptions: 12,
      mrr: usd(234_500),
      share: 0.19,
    },
  ],
  atRisk: {
    rows: [
      atRiskRow({
        id: 'r2',
        status: 'active',
        canceledAt: '2026-10-20T00:00:00.000Z',
        mrr: { amount: 4900, currency: 'usd' },
      }),
      atRiskRow({ id: 'r1' }),
    ],
    total: 2,
    mrr: usd(6_800),
  },
  ...overrides,
});

const trendPoint = (overrides: Partial<RevenueTrendPoint> & Pick<RevenueTrendPoint, 'date'>): RevenueTrendPoint => ({
  mrr: 0,
  payingCount: 0,
  newMrr: 0,
  churnedMrr: 0,
  pastDueMrr: 0,
  cancelingMrr: 0,
  payingUsers: 0,
  payingOrgs: 0,
  mrrByPlan: {},
  ...overrides,
});

let response: AdminRevenueResponse = revenue();

const renderTab = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<AdminRevenue />, { wrapper: Wrapper });
};

const tiles = () => screen.getAllByTestId('admin-stat-tile').map(tile => tile.textContent ?? '');

beforeEach(() => {
  apiGet.mockReset();
  response = revenue();
  apiGet.mockImplementation(async () => ({ data: response }));
  act(() => fakeAdminRouter.reset({ tab: 'revenue' }));
});

describe('AdminRevenue', () => {
  it('says when the trend starts before the first snapshot, with the current numbers in the strip', async () => {
    renderTab();
    expect(await screen.findByText('Trend starts collecting on October 30, 2026')).toBeTruthy();
    expect(screen.queryByTestId('admin-revenue-chart')).toBeNull();
    expect(screen.queryByTestId('admin-revenue-trend-table-toggle-btn')).toBeNull();
    const [mrr, arr, paying, newMrr, churned] = tiles();
    expect(mrr).toContain('$12.3K');
    expect(mrr).toContain('Not in total: 2 with no billed amount');
    expect(arr).toContain('$148.1K');
    expect(paying).toContain('42');
    expect(paying).toContain('$19.00 MRR at risk');
    expect(newMrr).toContain('$190.00');
    expect(newMrr).toContain('Last 30 days');
    expect(churned).toContain('$49.00');
    expect(apiGet).toHaveBeenCalledWith(ADMIN_REVENUE_PATH, { params: { range: '30d' } });
  });

  it('charts the snapshots with a takeaway, compares MRR with the start of the range, and offers a table', async () => {
    const trend = [
      trendPoint({ date: '2026-10-01', mrr: 1_000_000, payingCount: 40 }),
      trendPoint({ date: '2026-10-29', mrr: 1_100_000, payingCount: 41 }),
    ];
    response = revenue({ trend, startOfRange: trend[0], trendStartsOn: '2026-09-01' });
    renderTab();
    expect((await screen.findByTestId('admin-revenue-chart')).textContent).toBe('2026-10-01,2026-10-29');
    expect(screen.getByTestId('admin-revenue-trend-caption').textContent).toBe(
      'MRR is up 10.0% since Oct 1: $11,000.00 MRR from 41 paying.'
    );
    expect(tiles()[0]).toContain('+$2,345.00 since Oct 1');

    fireEvent.click(screen.getByTestId('admin-revenue-trend-table-toggle-btn'));
    const table = screen.getByTestId('admin-revenue-trend-table');
    expect(within(table).getByText('October 29, 2026')).toBeTruthy();
    expect(within(table).getByText('$11,000.00')).toBeTruthy();
    expect(screen.queryByTestId('admin-revenue-chart')).toBeNull();
  });

  it('says when every revenue chart starts collecting, before the first snapshot', async () => {
    renderTab();
    await screen.findByText('Trend starts collecting on October 30, 2026');
    for (const id of ['movement', 'plan-trend', 'by-owner', 'at-risk-trend']) {
      expect(screen.getByTestId(`admin-revenue-${id}-empty`).textContent).toBe(
        'Trend starts collecting on October 30, 2026.'
      );
      expect(screen.queryByTestId(`admin-revenue-${id}-table-toggle-btn`)).toBeNull();
    }
  });

  it('charts movement, plans, owners and at-risk MRR with takeaways and a table for each', async () => {
    const trend = [
      trendPoint({
        date: '2026-10-28',
        newMrr: 5_000,
        churnedMrr: 1_900,
        payingCount: 3,
        payingUsers: 2,
        payingOrgs: 1,
        mrrByPlan: { price_team: 3_000, none: 1_000 },
      }),
      trendPoint({
        date: '2026-10-29',
        payingCount: 4,
        payingUsers: 3,
        payingOrgs: 1,
        pastDueMrr: 1_900,
        cancelingMrr: 4_900,
        mrrByPlan: { price_team: 3_000, none: 1_000 },
      }),
    ];
    response = revenue({
      trend,
      startOfRange: trend[0],
      trendStartsOn: '2026-09-01',
      trendPlans: [
        { key: 'price_team', plan: { priceId: 'price_team', name: 'Team', interval: 'monthly' } },
        { key: 'none', plan: { priceId: null, name: null, interval: null } },
      ],
    });
    renderTab();
    expect((await screen.findByTestId('admin-revenue-movement-chart')).textContent).toBe('Oct 28,Oct 29');
    expect(screen.getByTestId('admin-revenue-movement-caption').textContent).toBe(
      'Net +$31.00 MRR in this range: $50.00 new, $19.00 churned.'
    );
    expect(screen.getByTestId('admin-revenue-by-plan-chart').textContent).toBe('Team,Unknown plan');
    expect(screen.getByTestId('admin-revenue-plan-trend-caption').textContent).toBe('Team is 75% of MRR on Oct 29.');
    expect(screen.getByTestId('admin-revenue-by-owner-caption').textContent).toBe(
      '4 paying on Oct 29: 3 individuals, 1 organization.'
    );
    expect(screen.getByTestId('admin-revenue-at-risk-trend-caption').textContent).toBe(
      '$19.00 past due and $49.00 canceling on Oct 29. A row can be both.'
    );

    fireEvent.click(screen.getByTestId('admin-revenue-movement-table-toggle-btn'));
    const movement = screen.getByTestId('admin-revenue-movement-table');
    expect(within(movement).getByText('$50.00')).toBeTruthy();
    expect(within(movement).getByText('-$19.00')).toBeTruthy();
    expect(screen.queryByTestId('admin-revenue-movement-chart')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-revenue-plan-trend-table-toggle-btn'));
    const plans = screen.getByTestId('admin-revenue-plan-trend-table');
    expect(within(plans).getByText('Team (USD)')).toBeTruthy();
    expect(within(plans).getAllByText('$40.00')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('admin-revenue-by-owner-table-toggle-btn'));
    expect(within(screen.getByTestId('admin-revenue-by-owner-table')).getByText('Organizations')).toBeTruthy();

    fireEvent.click(screen.getByTestId('admin-revenue-at-risk-trend-table-toggle-btn'));
    expect(within(screen.getByTestId('admin-revenue-at-risk-trend-table')).getByText('$49.00')).toBeTruthy();
  });

  it('asks for the picked range', async () => {
    renderTab();
    await screen.findByText('Trend starts collecting on October 30, 2026');
    fireEvent.click(screen.getByTestId('admin-revenue-range-90d'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(ADMIN_REVENUE_PATH, { params: { range: '90d' } }));
  });

  it('opens a plan as the Paying view narrowed to that price', async () => {
    renderTab();
    const row = await screen.findByTestId('admin-revenue-plan-row-price_team');
    expect(row.textContent).toContain('81%');
    expect(screen.getByTestId('admin-revenue-plan-row-price_legacy').textContent).toContain('Unknown plan');
    fireEvent.click(row);
    expect(fakeAdminRouter.search).toEqual({
      tab: 'subscriptions',
      subsPage: 1,
      subsStatus: ['active', 'past_due'],
      subsSource: 'stripe',
      subsPlan: ['price_team'],
    });
  });

  it('opens a plan with no price id as the Paying view narrowed to unknown plans', async () => {
    response = revenue({
      byPlan: [{ plan: { priceId: null, name: null, interval: null }, subscriptions: 3, mrr: usd(5_700), share: 1 }],
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-revenue-plan-row-none'));
    expect(fakeAdminRouter.search).toEqual({
      tab: 'subscriptions',
      subsPage: 1,
      subsStatus: ['active', 'past_due'],
      subsSource: 'stripe',
      subsPlan: ['unknown'],
    });
  });

  it('notes the rows New and Churned MRR leave out of their totals', async () => {
    const base = revenue();
    response = revenue({
      current: { ...base.current, newMrr: usd(19_000, { otherCurrency: 1 }), churnedMrr: usd(4_900, { unpriced: 2 }) },
    });
    renderTab();
    await screen.findByText('Trend starts collecting on October 30, 2026');
    const [, , , newMrr, churned] = tiles();
    expect(newMrr).toContain('Last 30 days. Not in total: 1 in another currency');
    expect(churned).toContain('Last 30 days. Not in total: 2 with no billed amount');
  });

  it('opens an at-risk row in the Past due or Canceling view it belongs to', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-revenue-at-risk-row-r1'));
    expect(fakeAdminRouter.search).toEqual({
      tab: 'subscriptions',
      subsPage: 1,
      subsStatus: ['past_due', 'unpaid', 'incomplete'],
    });

    fireEvent.click(screen.getByTestId('admin-revenue-at-risk-row-r2'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'subscriptions', subsPage: 1, subsCancel: 'scheduled' });
    expect(screen.getByTestId('admin-revenue-at-risk-summary').textContent).toBe(
      '$68.00 MRR at risk across 2 past due or canceling'
    );
  });

  it('links the section actions to the matching list views', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('admin-revenue-at-risk-canceling-btn'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'subscriptions', subsPage: 1, subsCancel: 'scheduled' });
    fireEvent.click(screen.getByTestId('admin-revenue-by-plan-view-btn'));
    expect(fakeAdminRouter.search).toEqual({
      tab: 'subscriptions',
      subsPage: 1,
      subsStatus: ['active', 'past_due'],
      subsSource: 'stripe',
    });
  });

  it('says Stripe is not configured on a deployment without it', async () => {
    response = { stripeConfigured: false };
    renderTab();
    expect(await screen.findByText("Stripe isn't configured on this deployment")).toBeTruthy();
    expect(screen.getByTestId('admin-revenue-self-host-docs-link').getAttribute('href')).toBe(
      'https://docs.bike4mind.com/self-host#2-configure-your-environment'
    );
    expect(screen.queryByTestId('admin-stat-strip')).toBeNull();
    expect(screen.queryByTestId('admin-revenue-range')).toBeNull();
  });

  it('offers a retry when the read fails', async () => {
    apiGet.mockRejectedValue(new Error('down'));
    renderTab();
    expect(await screen.findByTestId('admin-error-state')).toBeTruthy();
  });
});

describe('trendTakeaway', () => {
  it('describes a single snapshot, a flat trend and a fall', () => {
    expect(trendTakeaway([{ date: '2026-10-29', mrr: 1900, payingCount: 1 }])).toBe(
      'One snapshot so far (Oct 29): $19.00 MRR from 1 paying.'
    );
    expect(
      trendTakeaway([
        { date: '2026-10-01', mrr: 1900, payingCount: 1 },
        { date: '2026-10-02', mrr: 1900, payingCount: 1 },
      ])
    ).toBe('MRR is flat since Oct 1: $19.00 MRR from 1 paying.');
    expect(
      trendTakeaway([
        { date: '2026-10-01', mrr: 2000, payingCount: 2 },
        { date: '2026-10-02', mrr: 1500, payingCount: 1 },
      ])
    ).toBe('MRR is down 25.0% since Oct 1: $15.00 MRR from 1 paying.');
  });
});
