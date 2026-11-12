import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AdminSubscriptionDetail, AdminSubscriptionHistory } from '@client/app/utils/adminSubscriptionDetail';
import type { AdminStripeInvoice } from '@client/app/utils/adminSubscriptionStripe';
import type { AdminSubscriptionStripeState } from '@client/app/hooks/data/adminSubscriptionDetail';
import type React from 'react';
import { CREDITS_CHART_ID, PAYMENT_CHART_ID, SEATS_CHART_ID, SubscriptionChartsView } from './SubscriptionCharts';
import {
  STRIPE_ROW,
  SubscriptionTestWrapper,
  buildDetail,
  buildOrgDetail,
  buildStripeData,
  buildStripeState,
} from './subscriptionDetailTestUtils';

const chartInputs = vi.hoisted(() => ({ line: vi.fn<(data: unknown) => void>() }));
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  const ActualLineChart = actual.LineChart;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    LineChart: (props: React.ComponentProps<typeof ActualLineChart>) => {
      chartInputs.line(props.data);
      return <ActualLineChart {...props} />;
    },
  };
});

const invoice = (overrides: Partial<AdminStripeInvoice> = {}): AdminStripeInvoice => ({
  id: 'in_1',
  number: 'N-0001',
  createdAt: '2026-10-01T00:00:00.000Z',
  amountDue: 1900,
  amountPaid: 1900,
  currency: 'usd',
  status: 'paid',
  paidAt: '2026-10-01T00:00:00.000Z',
  attempts: 1,
  hostedInvoiceUrl: null,
  creditsGranted: 1000,
  amountRefunded: 0,
  ...overrides,
});

const HISTORY: AdminSubscriptionHistory = {
  creditCycles: [
    { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z', granted: 1000, used: 400, current: false },
    { start: '2026-11-01T00:00:00.000Z', end: '2026-11-12T00:00:00.000Z', granted: 1000, used: 50, current: true },
  ],
  creditCyclesTruncated: false,
  creditUsageUnavailable: false,
  seatChanges: [
    { at: '2026-10-01T00:00:00.000Z', quantity: 3 },
    { at: '2026-10-20T00:00:00.000Z', quantity: 5 },
  ],
};

type HistoryOverrides = Partial<{
  data: AdminSubscriptionHistory | undefined;
  dataUpdatedAt: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}>;

const history = (overrides: HistoryOverrides = {}) => ({
  data: HISTORY,
  dataUpdatedAt: Date.UTC(2026, 10, 12),
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  ...overrides,
});

const stripeDetail = () => buildDetail({ subscription: STRIPE_ROW });
const stripeOrgDetail = (): AdminSubscriptionDetail => {
  const org = buildOrgDetail();
  return {
    ...org,
    subscription: { ...org.subscription, ...STRIPE_ROW },
    seats: { paid: 5, organizationSeats: 5, members: 4, min: 2, max: 100 },
  };
};

const renderCharts = (
  detail: AdminSubscriptionDetail,
  stripe: AdminSubscriptionStripeState = buildStripeState(),
  historyState = history()
) =>
  render(<SubscriptionChartsView detail={detail} stripe={stripe} history={historyState} />, {
    wrapper: SubscriptionTestWrapper,
  });

describe('Payment history chart', () => {
  const paidAndFailed = buildStripeState({
    data: buildStripeData({
      invoices: [
        invoice({ id: 'in_2', number: 'N-0002', createdAt: '2026-11-01T00:00:00.000Z', status: 'uncollectible' }),
        invoice(),
      ],
    }),
  });

  it('renders the chart with a takeaway and a legend of the outcomes present', () => {
    renderCharts(stripeDetail(), paidAndFailed);
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-caption`)).toHaveTextContent(
      '2 invoices since 1 Oct 2026: 1 paid, 1 failed. Latest: $19.00 failed on 1 Nov 2026.'
    );
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-chart`)).toBeInTheDocument();
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-chart-legend`)).toHaveTextContent('PaidFailed');
  });

  it('toggles to an exact-value table and back', () => {
    renderCharts(stripeDetail(), paidAndFailed);
    const toggle = screen.getByTestId(`${PAYMENT_CHART_ID}-table-toggle-btn`);
    fireEvent.click(toggle);
    const table = screen.getByTestId(`${PAYMENT_CHART_ID}-table`);
    expect(within(table).getByText('N-0002')).toBeInTheDocument();
    expect(within(table).getAllByText('$19.00')).toHaveLength(2);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByTestId(`${PAYMENT_CHART_ID}-table`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-chart`)).toBeInTheDocument();
  });

  it('shows a chart-shaped skeleton while Stripe loads', () => {
    renderCharts(stripeDetail(), buildStripeState({ data: undefined, isLoading: true }));
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-skeleton`)).toBeInTheDocument();
    expect(screen.queryByTestId(`${PAYMENT_CHART_ID}-table-toggle-btn`)).not.toBeInTheDocument();
  });

  it('shows the Stripe error with Try again, and keeps the ledger charts up', () => {
    const refetchFresh = vi.fn();
    renderCharts(stripeDetail(), buildStripeState({ data: undefined, isError: true, refetchFresh }));
    const error = screen.getByTestId(`${PAYMENT_CHART_ID}-error`);
    expect(error).toHaveTextContent('Stripe request failed. The rest of this page is from our records.');
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(refetchFresh).toHaveBeenCalled();
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-chart`)).toBeInTheDocument();
  });

  it('says when Stripe is not configured', () => {
    renderCharts(stripeDetail(), buildStripeState({ data: { stripeConfigured: false } }));
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-unconfigured`)).toHaveTextContent(
      "Stripe isn't configured on this deployment"
    );
  });

  it('says payment history starts with the first invoice when there is none', () => {
    renderCharts(stripeDetail());
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-empty`)).toHaveTextContent(
      'Payment history starts with the first invoice.'
    );
  });

  it('is not shown for a comp, which Stripe never bills', () => {
    renderCharts(buildDetail());
    expect(screen.queryByTestId(PAYMENT_CHART_ID)).not.toBeInTheDocument();
    expect(screen.getByTestId(CREDITS_CHART_ID)).toBeInTheDocument();
  });
});

describe('Credits per cycle chart without usage', () => {
  const degraded = history({
    data: {
      ...HISTORY,
      creditUsageUnavailable: true,
      creditCycles: HISTORY.creditCycles.map(cycle => ({ ...cycle, used: null })),
    },
  });

  it('shows granted only, a dash for Used, and the note', () => {
    renderCharts(stripeDetail(), buildStripeState(), degraded);
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-chart-legend`)).toHaveTextContent('Granted');
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-chart-legend`)).not.toHaveTextContent('Used');
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-caption`).textContent).not.toMatch(/used/i);
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-note`)).toHaveTextContent(
      'Usage is too large to total here; granted credits only.'
    );
    fireEvent.click(screen.getByTestId(`${CREDITS_CHART_ID}-table-toggle-btn`));
    const table = screen.getByTestId(`${CREDITS_CHART_ID}-table`);
    expect(within(table).getAllByLabelText('Not totaled')).toHaveLength(2);
  });
});

describe('Credits per cycle chart', () => {
  it('renders granted vs used with a takeaway and a table fallback', () => {
    renderCharts(stripeDetail());
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-caption`)).toHaveTextContent(
      'The last full cycle used 400 of 1,000 credits granted (40%). This cycle has used 50 of 1,000 so far.'
    );
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-note`)).toHaveTextContent('from any credit source');
    fireEvent.click(screen.getByTestId(`${CREDITS_CHART_ID}-table-toggle-btn`));
    const table = screen.getByTestId(`${CREDITS_CHART_ID}-table`);
    expect(within(table).getByText('Running')).toBeInTheDocument();
    expect(within(table).getByText('400')).toBeInTheDocument();
  });

  it('shows a skeleton while the history loads', () => {
    renderCharts(stripeDetail(), buildStripeState(), history({ data: undefined, isLoading: true }));
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-skeleton`)).toBeInTheDocument();
  });

  it('says cycles start with the first grant when there is none', () => {
    renderCharts(stripeDetail(), buildStripeState(), history({ data: { ...HISTORY, creditCycles: [] } }));
    expect(screen.getByTestId(`${CREDITS_CHART_ID}-empty`)).toHaveTextContent(
      'Cycles start with the first plan credit grant after 1 Oct 2026.'
    );
  });

  it('shows an error with Try again when the history fails', () => {
    const refetch = vi.fn();
    renderCharts(stripeDetail(), buildStripeState(), history({ data: undefined, isError: true, refetch }));
    fireEvent.click(within(screen.getByTestId(`${CREDITS_CHART_ID}-error`)).getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('Seats used vs paid chart', () => {
  it('is hidden for a user subscription', () => {
    renderCharts(stripeDetail());
    expect(screen.queryByTestId(SEATS_CHART_ID)).not.toBeInTheDocument();
  });

  it('steps through paid seats and marks used seats as today only', () => {
    renderCharts(stripeOrgDetail());
    expect(screen.getByTestId(`${SEATS_CHART_ID}-caption`)).toHaveTextContent(
      '4 of 5 paid seats used today. Paid seats went from 3 to 5 since 1 Oct 2026.'
    );
    expect(screen.getByTestId(`${SEATS_CHART_ID}-chart-legend`)).toHaveTextContent('Used seats (today only)');
    fireEvent.click(screen.getByTestId(`${SEATS_CHART_ID}-table-toggle-btn`));
    const table = screen.getByTestId(`${SEATS_CHART_ID}-table`);
    expect(within(table).getAllByLabelText('Not recorded')).toHaveLength(2);
  });

  it('says history starts with the next seat change when none is recorded', () => {
    renderCharts(stripeOrgDetail(), buildStripeState(), history({ data: { ...HISTORY, seatChanges: [] } }));
    expect(screen.getByTestId(`${SEATS_CHART_ID}-empty`)).toHaveTextContent(
      'History starts with the next seat change Stripe reports. Today: 4 used of 5 paid.'
    );
  });

  it('explains an org comp has no billing history', () => {
    const comp = { ...buildOrgDetail(), seats: { paid: 5, organizationSeats: 5, members: 3, min: 2, max: 100 } };
    renderCharts(comp, buildStripeState(), history({ data: { ...HISTORY, seatChanges: [] } }));
    expect(screen.getByTestId(`${SEATS_CHART_ID}-empty`)).toHaveTextContent('Comped seats have no billing history');
  });

  it('shows a skeleton while the history loads', () => {
    renderCharts(stripeOrgDetail(), buildStripeState(), history({ data: undefined, isLoading: true }));
    expect(screen.getByTestId(`${SEATS_CHART_ID}-skeleton`)).toBeInTheDocument();
  });
});

describe('cached chart refresh failures', () => {
  it.each([false, true])('discloses stale credit and seat history, including empty=%s', empty => {
    const refetch = vi.fn();
    const data = empty ? { ...HISTORY, creditCycles: [], seatChanges: [] } : HISTORY;
    renderCharts(stripeOrgDetail(), buildStripeState(), history({ data, isError: true, refetch }));

    for (const chart of [CREDITS_CHART_ID, SEATS_CHART_ID]) {
      const warning = screen.getByTestId(`${chart}-stale`);
      expect(warning).toHaveTextContent('Showing previously loaded records');
      fireEvent.click(within(warning).getByTestId('admin-error-retry-btn'));
      expect(screen.getByTestId(`${chart}-${empty ? 'empty' : 'chart'}`)).toBeInTheDocument();
    }
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('discloses a failed Stripe refresh even when the cached invoice list is empty', () => {
    const refetchFresh = vi.fn();
    renderCharts(stripeDetail(), buildStripeState({ isError: true, refetchFresh }));
    expect(screen.getByTestId(`${PAYMENT_CHART_ID}-empty`)).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId(`${PAYMENT_CHART_ID}-stale`)).getByTestId('admin-error-retry-btn'));
    expect(refetchFresh).toHaveBeenCalledOnce();
  });
});

describe('seat snapshot refresh', () => {
  it('places refreshed current counts after a newly fetched change without remounting', () => {
    const initialTime = Date.UTC(2026, 10, 12);
    const laterEvent = initialTime + 60_000;
    const refreshedTime = laterEvent + 60_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(initialTime);
    try {
      const detail = stripeOrgDetail();
      const view = renderCharts(detail, buildStripeState(), history({ dataUpdatedAt: initialTime }));
      now.mockReturnValue(refreshedTime);
      const changes = [...(HISTORY.seatChanges ?? []), { at: new Date(laterEvent).toISOString(), quantity: 7 }];
      const updated = { ...detail, seats: { ...detail.seats!, paid: 7, members: 6 } };
      view.rerender(
        <SubscriptionChartsView
          detail={updated}
          stripe={buildStripeState()}
          history={history({
            data: { ...HISTORY, seatChanges: changes },
            dataUpdatedAt: refreshedTime,
          })}
        />
      );

      expect(chartInputs.line.mock.calls.at(-1)?.[0]).toEqual([
        ...changes.map(change => ({ at: new Date(change.at).getTime(), paid: change.quantity, used: null })),
        { at: refreshedTime, paid: 7, used: 6 },
      ]);
    } finally {
      now.mockRestore();
    }
  });
});
