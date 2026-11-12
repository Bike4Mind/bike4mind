import React, { useMemo, type ReactNode } from 'react';
import { Box, Typography } from '@mui/joy';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import {
  useAdminSubscriptionHistory,
  type AdminSubscriptionStripeState,
} from '@client/app/hooks/data/adminSubscriptionDetail';
import {
  MAX_CREDIT_CYCLES,
  isCompSubscription,
  type AdminSubscriptionDetail,
  type AdminSubscriptionHistory,
  type AdminSubscriptionSeats,
} from '@client/app/utils/adminSubscriptionDetail';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ChartDataTable,
  ChartSection,
  Dash,
  EmptyState,
  ErrorState,
  StatusChip,
  formatMoney,
  type ChartSectionBody,
  type DataColumn,
} from '../../shared';
import {
  ACCENT,
  BAD,
  BORDER,
  COMPARISON_OPACITY,
  ChartFrame,
  GOOD,
  INFO,
  INK_MUTED,
  NEUTRAL,
  WARN,
  tooltipFor,
  xAxisProps,
  yAxisProps,
  type ChartLegendItem,
} from '../../shared/chartParts';
import { formatTrendDay } from '../../Revenue/revenueFormat';
import { formatCredits } from '../../Users/Profile/actions/creditAdjustment';
import { STRIPE_STALE_MESSAGE, StripeSection } from './stripeSections';
import { formatDate } from './subscriptionDetailModel';
import {
  PAYMENT_OUTCOMES,
  creditsTakeaway,
  paymentTakeaway,
  seatsTakeaway,
  toCreditCyclePoints,
  toPaymentHistory,
  toSeatPoints,
  type CreditCyclePoint,
  type PaymentBar,
  type PaymentOutcome,
  type SeatPoint,
} from './subscriptionChartData';

export const PAYMENT_CHART_ID = 'subscription-payment-history';
export const CREDITS_CHART_ID = 'subscription-credit-cycles';
export const SEATS_CHART_ID = 'subscription-seats-history';

const TONE_COLORS: Readonly<Record<AdminStatusTone, string>> = {
  good: GOOD,
  warn: WARN,
  bad: BAD,
  info: INFO,
  neutral: NEUTRAL,
};
const outcomeColor = (outcome: PaymentOutcome) => TONE_COLORS[PAYMENT_OUTCOMES[outcome].tone];

const axisDay = (iso: string) => formatTrendDay(iso.slice(0, 10));
const axisMs = (ms: number) => axisDay(new Date(ms).toISOString());
const compactCount = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value);
const MARGIN = { top: 8, right: 4, left: 0, bottom: 0 };

const Note: React.FC<{ testId: string; children: ReactNode }> = ({ testId, children }) => (
  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
    {children}
  </Typography>
);

const notice = (testId: string, title: string, description?: string): ChartSectionBody => ({
  kind: 'notice',
  content: (
    <Box data-testid={`${testId}-empty`}>
      <EmptyState title={title} description={description} action={null} />
    </Box>
  ),
});

/** Keep cached charts and empty states usable while disclosing a failed refresh. */
const withStaleNotice = (body: ChartSectionBody, warning: ReactNode): ChartSectionBody => {
  if (!warning || body.kind === 'loading') return body;
  if (body.kind === 'ready')
    return {
      ...body,
      footnote: (
        <>
          {body.footnote}
          {warning}
        </>
      ),
    };
  return {
    ...body,
    content: (
      <>
        {body.content}
        {warning}
      </>
    ),
  };
};

const PaymentHistoryPlot: React.FC<{ bars: readonly PaymentBar[]; currency: string }> = ({ bars, currency }) => {
  const legend: ChartLegendItem[] = (Object.keys(PAYMENT_OUTCOMES) as PaymentOutcome[])
    .filter(outcome => bars.some(bar => bar.outcome === outcome))
    .map(outcome => ({ label: PAYMENT_OUTCOMES[outcome].label, color: outcomeColor(outcome) }));
  const chartId = `${PAYMENT_CHART_ID}-chart`;
  return (
    <ChartFrame testId={chartId} legend={legend}>
      <BarChart data={[...bars]} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke={BORDER} />
        <XAxis dataKey="createdAt" tickFormatter={axisDay} {...xAxisProps} />
        <YAxis
          tickFormatter={(value: number) => formatMoney(value, currency, { compact: true })}
          width={72}
          {...yAxisProps}
        />
        <Tooltip
          cursor={{ fill: BORDER, fillOpacity: 0.4 }}
          content={tooltipFor<PaymentBar>(chartId, bar => ({
            title: `${formatDate(bar.createdAt)}${bar.number ? `, ${bar.number}` : ''}`,
            lines: [
              {
                label: PAYMENT_OUTCOMES[bar.outcome].label,
                value: formatMoney(bar.amount, bar.currency),
                color: outcomeColor(bar.outcome),
              },
              ...(bar.refunded > 0 ? [{ label: 'Refunded', value: formatMoney(-bar.refunded, bar.currency) }] : []),
            ],
          }))}
        />
        <Bar dataKey="amount" name="Amount" isAnimationActive={false}>
          {bars.map(bar => (
            <Cell key={bar.id} fill={outcomeColor(bar.outcome)} />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
};

const paymentColumns = (currency: string): DataColumn<PaymentBar>[] => [
  { id: 'date', label: 'Date', render: bar => formatDate(bar.createdAt), sortValue: bar => bar.createdAt },
  { id: 'number', label: 'Number', render: bar => bar.number ?? bar.id },
  {
    id: 'amount',
    label: `Amount (${currency.toUpperCase()})`,
    numeric: true,
    render: bar => formatMoney(bar.amount, bar.currency),
    sortValue: bar => bar.amount,
  },
  {
    id: 'refunded',
    label: `Refunded (${currency.toUpperCase()})`,
    numeric: true,
    render: bar => (bar.refunded > 0 ? formatMoney(-bar.refunded, bar.currency) : <Dash />),
    sortValue: bar => bar.refunded,
  },
  {
    id: 'status',
    label: 'Status',
    render: bar => (
      <StatusChip tone={PAYMENT_OUTCOMES[bar.outcome].tone} label={PAYMENT_OUTCOMES[bar.outcome].label} dot />
    ),
  },
];

/** Invoice amounts per period from the live Stripe read, toned by outcome; degrades like the other Stripe sections. */
export const PaymentHistoryChart: React.FC<{ stripe: AdminSubscriptionStripeState }> = ({ stripe }) => {
  const { data } = stripe;
  const live = data?.stripeConfigured && data.kind === 'stripe' ? data : null;
  const history = useMemo(() => (live ? toPaymentHistory(live.invoices) : null), [live]);
  let body: ChartSectionBody;
  if (history && history.currency && history.bars.length > 0) {
    const { currency, olderCount, otherCurrencyCount } = history;
    const notes = [
      olderCount > 0 &&
        (olderCount === 1
          ? 'The 1 older invoice is on the Invoices tab.'
          : `The ${olderCount} older invoices are on the Invoices tab.`),
      otherCurrencyCount > 0 &&
        (otherCurrencyCount === 1
          ? '1 invoice in another currency is on the Invoices tab, not in this chart.'
          : `${otherCurrencyCount} invoices in other currencies are on the Invoices tab, not in this chart.`),
    ].filter(Boolean);
    body = {
      kind: 'ready',
      caption: paymentTakeaway(history),
      chart: <PaymentHistoryPlot bars={history.bars} currency={currency} />,
      table: (
        <ChartDataTable
          label="Payment history"
          testId={`${PAYMENT_CHART_ID}-table`}
          rows={history.bars}
          columns={paymentColumns(currency)}
          getRowId={bar => bar.id}
        />
      ),
      footnote: <>{notes.length > 0 && <Note testId={`${PAYMENT_CHART_ID}-note`}>{notes.join(' ')}</Note>}</>,
    };
  } else if (live) {
    body = notice(PAYMENT_CHART_ID, 'No invoices yet', 'Payment history starts with the first invoice.');
  } else if (!data && stripe.isLoading) {
    body = { kind: 'loading' };
  } else {
    body = {
      kind: 'notice',
      content: (
        <StripeSection stripe={stripe} testIdPrefix={PAYMENT_CHART_ID}>
          {() => null}
        </StripeSection>
      ),
    };
  }
  const warning =
    live && stripe.isError ? (
      <Box data-testid={`${PAYMENT_CHART_ID}-stale`}>
        <ErrorState message={STRIPE_STALE_MESSAGE} onRetry={stripe.refetchFresh} retrying={stripe.isFetching} />
      </Box>
    ) : null;
  return <ChartSection title="Payment history" testId={PAYMENT_CHART_ID} body={withStaleNotice(body, warning)} />;
};

type HistoryState = {
  data: AdminSubscriptionHistory | undefined;
  dataUpdatedAt: number;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

const historyError = (testId: string, history: HistoryState, what: string): ChartSectionBody => ({
  kind: 'notice',
  content: (
    <Box data-testid={`${testId}-error`}>
      <ErrorState message={`Could not load ${what}.`} onRetry={history.refetch} retrying={history.isFetching} />
    </Box>
  ),
});

const historyStaleNotice = (testId: string, history: HistoryState) =>
  history.data && history.isError ? (
    <Box data-testid={`${testId}-stale`}>
      <ErrorState
        message="History refresh failed. Showing previously loaded records."
        onRetry={history.refetch}
        retrying={history.isFetching}
      />
    </Box>
  ) : null;

const GRANTED_ITEM: ChartLegendItem = { label: 'Granted', color: INK_MUTED, opacity: COMPARISON_OPACITY };
const CREDITS_LEGEND: ChartLegendItem[] = [GRANTED_ITEM, { label: 'Used', color: ACCENT }];
const GRANTED_ONLY_LEGEND: ChartLegendItem[] = [GRANTED_ITEM];
const USAGE_UNAVAILABLE_NOTE = 'Usage is too large to total here; granted credits only.';

const CreditCyclesPlot: React.FC<{ points: readonly CreditCyclePoint[]; usageUnavailable: boolean }> = ({
  points,
  usageUnavailable,
}) => {
  const chartId = `${CREDITS_CHART_ID}-chart`;
  return (
    <ChartFrame testId={chartId} legend={usageUnavailable ? GRANTED_ONLY_LEGEND : CREDITS_LEGEND}>
      <BarChart data={[...points]} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke={BORDER} />
        <XAxis dataKey="start" tickFormatter={axisDay} {...xAxisProps} />
        <YAxis tickFormatter={compactCount} allowDecimals={false} width={56} {...yAxisProps} />
        <Tooltip
          cursor={{ fill: BORDER, fillOpacity: 0.4 }}
          content={tooltipFor<CreditCyclePoint>(chartId, point => ({
            title: `${point.label} to ${point.current ? 'now' : formatDate(point.end)}`,
            lines: [
              {
                label: 'Granted',
                value: formatCredits(point.granted),
                color: INK_MUTED,
                opacity: COMPARISON_OPACITY,
              },
              ...(point.used === null
                ? []
                : [{ label: point.current ? 'Used so far' : 'Used', value: formatCredits(point.used), color: ACCENT }]),
            ],
          }))}
        />
        <Bar
          dataKey="granted"
          name="Granted"
          fill={INK_MUTED}
          fillOpacity={COMPARISON_OPACITY}
          isAnimationActive={false}
        />
        {!usageUnavailable && <Bar dataKey="used" name="Used" fill={ACCENT} isAnimationActive={false} />}
      </BarChart>
    </ChartFrame>
  );
};

const CREDIT_COLUMNS: DataColumn<CreditCyclePoint>[] = [
  { id: 'start', label: 'Cycle start', render: point => point.label, sortValue: point => point.start },
  {
    id: 'end',
    label: 'Cycle end',
    render: point => (point.current ? 'Running' : formatDate(point.end)),
    sortValue: point => point.end,
  },
  {
    id: 'granted',
    label: 'Granted (credits)',
    numeric: true,
    render: point => formatCredits(point.granted),
    sortValue: point => point.granted,
  },
  {
    id: 'used',
    label: 'Used (credits)',
    numeric: true,
    render: point => (point.used === null ? <Dash title="Not totaled" /> : formatCredits(point.used)),
    sortValue: point => point.used ?? -1,
  },
];

/** Credits granted vs used per plan cycle, from the owner's credit ledger. */
export const CreditCyclesChart: React.FC<{ detail: AdminSubscriptionDetail; history: HistoryState }> = ({
  detail,
  history,
}) => {
  const cycles = history.data?.creditCycles;
  const points = useMemo(() => toCreditCyclePoints(cycles ?? []), [cycles]);
  let body: ChartSectionBody;
  if (history.data && points.length > 0) {
    body = {
      kind: 'ready',
      caption: creditsTakeaway(points),
      chart: <CreditCyclesPlot points={points} usageUnavailable={history.data.creditUsageUnavailable} />,
      table: (
        <ChartDataTable
          label="Credits per cycle"
          testId={`${CREDITS_CHART_ID}-table`}
          rows={points}
          columns={CREDIT_COLUMNS}
          getRowId={point => point.start}
        />
      ),
      footnote: (
        <Note testId={`${CREDITS_CHART_ID}-note`}>
          {history.data.creditUsageUnavailable
            ? USAGE_UNAVAILABLE_NOTE
            : 'Used counts everything the owner spent in the cycle, from any credit source.'}
          {history.data.creditCyclesTruncated && ` Showing the latest ${MAX_CREDIT_CYCLES} cycles.`}
        </Note>
      ),
    };
  } else if (history.data) {
    const since = formatDate(detail.subscription.createdAt);
    body = notice(
      CREDITS_CHART_ID,
      'No plan credits granted yet',
      `Cycles start with the first plan credit grant${since ? ` after ${since}` : ''}.`
    );
  } else if (history.isError) {
    body = historyError(CREDITS_CHART_ID, history, 'credit history');
  } else {
    body = { kind: 'loading' };
  }
  return (
    <ChartSection
      title="Credits per cycle"
      testId={CREDITS_CHART_ID}
      body={withStaleNotice(body, historyStaleNotice(CREDITS_CHART_ID, history))}
    />
  );
};

const SEATS_LEGEND: ChartLegendItem[] = [
  { label: 'Paid seats', color: INK_MUTED, opacity: COMPARISON_OPACITY },
  { label: 'Used seats (today only)', color: ACCENT },
];

const SeatsPlot: React.FC<{ points: readonly SeatPoint[] }> = ({ points }) => {
  const chartId = `${SEATS_CHART_ID}-chart`;
  return (
    <ChartFrame testId={chartId} legend={SEATS_LEGEND}>
      <LineChart data={[...points]} margin={MARGIN}>
        <CartesianGrid vertical={false} stroke={BORDER} />
        <XAxis
          dataKey="at"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={axisMs}
          {...xAxisProps}
        />
        <YAxis allowDecimals={false} width={40} {...yAxisProps} />
        <Tooltip
          cursor={{ stroke: BORDER }}
          content={tooltipFor<SeatPoint>(chartId, point => ({
            title: axisMs(point.at),
            lines: [
              {
                label: 'Paid',
                value: point.paid.toLocaleString('en-US'),
                color: INK_MUTED,
                opacity: COMPARISON_OPACITY,
              },
              ...(point.used === null
                ? []
                : [{ label: 'Used', value: point.used.toLocaleString('en-US'), color: ACCENT }]),
            ],
          }))}
        />
        <Line
          dataKey="paid"
          name="Paid seats"
          type="stepAfter"
          stroke={INK_MUTED}
          strokeOpacity={COMPARISON_OPACITY}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          dataKey="used"
          name="Used seats"
          type="stepAfter"
          stroke={ACCENT}
          strokeWidth={2}
          dot={{ r: 4, fill: ACCENT, stroke: ACCENT }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartFrame>
  );
};

const SEAT_COLUMNS: DataColumn<SeatPoint>[] = [
  { id: 'date', label: 'Date', render: point => formatDate(new Date(point.at)), sortValue: point => point.at },
  {
    id: 'paid',
    label: 'Paid seats',
    numeric: true,
    render: point => point.paid.toLocaleString('en-US'),
    sortValue: point => point.paid,
  },
  {
    id: 'used',
    label: 'Used seats',
    numeric: true,
    render: point => (point.used === null ? <Dash title="Not recorded" /> : point.used.toLocaleString('en-US')),
    sortValue: point => point.used ?? -1,
  },
];

/** Paid seats from the stored Stripe subscription events; used seats only as of today (no member history). */
export const SeatsHistoryChart: React.FC<{
  seats: AdminSubscriptionSeats;
  comp: boolean;
  history: HistoryState;
}> = ({ seats, comp, history }) => {
  const changes = history.data?.seatChanges;
  const points = useMemo(
    () => toSeatPoints(changes ?? [], seats, history.dataUpdatedAt),
    [changes, seats, history.dataUpdatedAt]
  );
  const today = `Today: ${seats.members.toLocaleString('en-US')} used of ${seats.paid.toLocaleString('en-US')} paid.`;
  let body: ChartSectionBody;
  if (changes && changes.length > 0) {
    body = {
      kind: 'ready',
      caption: seatsTakeaway(changes, seats),
      chart: <SeatsPlot points={points} />,
      table: (
        <ChartDataTable
          label="Seats used vs paid"
          testId={`${SEATS_CHART_ID}-table`}
          rows={points}
          columns={SEAT_COLUMNS}
          getRowId={point => String(point.at)}
        />
      ),
      footnote: (
        <Note testId={`${SEATS_CHART_ID}-note`}>
          {
            "Paid seats are the quantities Stripe reported, and today from our records. Member history isn't recorded, so used seats show today only."
          }
        </Note>
      ),
    };
  } else if (changes) {
    body = comp
      ? notice(SEATS_CHART_ID, 'Comped seats have no billing history', `Stripe never bills a comp. ${today}`)
      : notice(
          SEATS_CHART_ID,
          'No seat changes recorded yet',
          `History starts with the next seat change Stripe reports. ${today}`
        );
  } else if (history.isError) {
    body = historyError(SEATS_CHART_ID, history, 'seat history');
  } else {
    body = { kind: 'loading' };
  }
  return (
    <ChartSection
      title="Seats used vs paid"
      testId={SEATS_CHART_ID}
      body={withStaleNotice(body, historyStaleNotice(SEATS_CHART_ID, history))}
    />
  );
};

/** The Overview tab's charts. Each loads and fails on its own, so a Stripe outage leaves the Mongo charts up. */
export const SubscriptionChartsView: React.FC<{
  detail: AdminSubscriptionDetail;
  stripe: AdminSubscriptionStripeState;
  history: HistoryState;
}> = ({ detail, stripe, history }) => {
  const comp = isCompSubscription(detail.subscription);
  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}
      data-testid="subscription-detail-charts"
    >
      {!comp && <PaymentHistoryChart stripe={stripe} />}
      <CreditCyclesChart detail={detail} history={history} />
      {detail.seats && <SeatsHistoryChart seats={detail.seats} comp={comp} history={history} />}
    </Box>
  );
};

export const SubscriptionCharts: React.FC<{
  detail: AdminSubscriptionDetail;
  stripe: AdminSubscriptionStripeState;
}> = ({ detail, stripe }) => {
  const query = useAdminSubscriptionHistory(detail.subscription.id);
  const history: HistoryState = {
    data: query.data,
    dataUpdatedAt: query.dataUpdatedAt,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
  return <SubscriptionChartsView detail={detail} stripe={stripe} history={history} />;
};
