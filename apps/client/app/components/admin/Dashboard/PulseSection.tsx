import { Stack } from '@mui/joy';
import type { SpendData } from '@bike4mind/common';
import type { AdminRevenueTrendResponse } from '@bike4mind/server-utils/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import type { AnalyticsOverview } from '@client/app/utils/analyticsOverview';
import { ErrorState, LoadingState, StatSparkline, StatStrip, StatTile, formatMoney } from '../shared';
import { comparisonLine, formatCount, formatPercent, sparklineValues } from '../Analytics/analyticsFormat';
import { formatUsd } from '../SpendExplorer/spendExplorerModel';
import { RANGE_DAYS, spendKpi, trendWindow, type DashboardRange } from './dashboardRange';

type QueryState<T> = { data: T | undefined; isLoading: boolean; isError: boolean; refetch: () => unknown };

const LOADING_VALUE = '\u2026';
const FAILED = 'Could not load';

function UsageStrip({ overview }: { overview: AnalyticsOverview }) {
  const { stats, window } = overview;
  const days = overview.activeUsers.days.filter(day => !day.partial);
  const line = (value: number | null, previous: number | null, unit?: 'points') =>
    window.previous ? comparisonLine(value, previous, window.completeDays, unit) : undefined;
  const signupSeries = overview.signups.buckets.filter(bucket => !bucket.partial).map(bucket => bucket.legit);
  const stickinessSeries = days.map(day => (day.dau !== null && day.mau ? (day.dau / day.mau) * 100 : null));

  return (
    <StatStrip aria-label="Usage">
      <StatTile
        label="Daily active (avg)"
        value={formatCount(stats.avgDau.value)}
        comparison={line(stats.avgDau.value, stats.avgDau.previous)}
        sparkline={<StatSparkline values={sparklineValues(days.map(day => day.dau))} label="DAU per day" />}
      />
      <StatTile
        label="Monthly active (MAU)"
        value={formatCount(stats.mau.value)}
        comparison={line(stats.mau.value, stats.mau.previous)}
        sparkline={<StatSparkline values={sparklineValues(days.map(day => day.mau))} label="MAU per day" />}
      />
      <StatTile
        label="Stickiness (DAU / MAU)"
        value={formatPercent(stats.stickiness.value)}
        comparison={line(stats.stickiness.value, stats.stickiness.previous, 'points')}
        sparkline={<StatSparkline values={sparklineValues(stickinessSeries)} label="Stickiness per day" />}
      />
      <StatTile
        label="New signups (likely legit)"
        value={formatCount(stats.newSignups.value)}
        comparison={line(stats.newSignups.value, stats.newSignups.previous)}
        sparkline={<StatSparkline values={sparklineValues(signupSeries)} label="Signups per bucket" />}
      />
    </StatStrip>
  );
}

/**
 * Active users over the range: WAU on the last complete day for a week, MAU for 28 days, so the
 * cost and the people it served cover the same span.
 */
export function activeUsersForRange(overview: AnalyticsOverview, range: DashboardRange) {
  if (range === '28d') return { value: overview.stats.mau.value, previous: overview.stats.mau.previous };
  const lastComplete = overview.activeUsers.days.filter(day => !day.partial).at(-1);
  return { value: lastComplete?.wau ?? null, previous: null };
}

export function costPerActiveUser(spend: SpendData, overview: AnalyticsOverview, range: DashboardRange) {
  const cost = spendKpi(spend, 'estCost');
  const users = activeUsersForRange(overview, range);
  const per = (amount: number | undefined, people: number | null) =>
    amount === undefined || !people ? null : amount / people;
  return { value: per(cost?.value, users.value), previous: per(cost?.priorValue, users.previous) };
}

export function mrrPoints(revenue: AdminRevenueTrendResponse | undefined, days: number) {
  if (!revenue?.stripeConfigured || revenue.trend.length === 0) return null;
  const { trend } = revenue;
  return { latest: trend[trend.length - 1], previous: trendWindow(trend, days).baseline, trend };
}

function MoneyStrip({
  range,
  spend,
  overview,
  revenue,
}: {
  range: DashboardRange;
  spend: QueryState<SpendData>;
  overview: QueryState<AnalyticsOverview>;
  revenue: QueryState<AdminRevenueTrendResponse>;
}) {
  const days = RANGE_DAYS[range];
  const cost = spendKpi(spend.data, 'estCost');
  const credits = spendKpi(spend.data, 'creditsUsed');
  const spendState = (render: () => string) => (spend.isLoading ? LOADING_VALUE : spend.isError ? '-' : render());
  const spendComparison = (value?: number, prior?: number) =>
    spend.isError ? FAILED : value === undefined ? undefined : comparisonLine(value, prior ?? null, days);

  const perUser = spend.data && overview.data ? costPerActiveUser(spend.data, overview.data, range) : null;
  const mrr = mrrPoints(revenue.data, days);
  const dailyCost = spend.data?.dailyCost.map(point => point.cost) ?? [];

  return (
    <StatStrip aria-label="Money">
      <StatTile
        label="LLM cost (provider)"
        value={spendState(() => formatUsd(cost?.value ?? 0, { compact: true }))}
        comparison={spendComparison(cost?.value, cost?.priorValue)}
        sparkline={dailyCost.length > 0 && <StatSparkline values={sparklineValues(dailyCost)} label="Cost per day" />}
      />
      <StatTile
        label={range === '7d' ? 'Cost per weekly active user' : 'Cost per monthly active user'}
        value={
          spend.isLoading || overview.isLoading
            ? LOADING_VALUE
            : perUser?.value == null
              ? '-'
              : formatMoney(Math.round(perUser.value * 100), 'usd')
        }
        comparison={
          spend.isError || overview.isError
            ? FAILED
            : perUser?.value != null && perUser.previous != null
              ? comparisonLine(perUser.value, perUser.previous, days)
              : 'All LLM cost divided by external active users'
        }
      />
      <StatTile
        label="MRR"
        value={
          revenue.isLoading ? LOADING_VALUE : mrr ? formatMoney(mrr.latest.mrr, MRR_CURRENCY, { compact: true }) : '-'
        }
        comparison={
          revenue.isError
            ? FAILED
            : revenue.data && !revenue.data.stripeConfigured
              ? 'Stripe is not configured'
              : mrr
                ? comparisonLine(mrr.latest.mrr, mrr.previous?.mrr ?? null, days)
                : 'No revenue snapshots yet'
        }
        sparkline={
          mrr && <StatSparkline values={sparklineValues(mrr.trend.map(point => point.mrr))} label="MRR per day" />
        }
      />
      <StatTile
        label="Credits used"
        value={spendState(() => formatCount(credits?.value ?? 0))}
        comparison={spendComparison(credits?.value, credits?.priorValue)}
      />
    </StatStrip>
  );
}

/** The day-to-day numbers: who is using Bike4Mind, what it costs, and what it earns. */
export function PulseSection({
  range,
  overview,
  spend,
  revenue,
}: {
  range: DashboardRange;
  overview: QueryState<AnalyticsOverview>;
  spend: QueryState<SpendData>;
  revenue: QueryState<AdminRevenueTrendResponse>;
}) {
  return (
    <Stack gap={1.5} data-testid="admin-dashboard-pulse">
      {overview.isLoading ? (
        <LoadingState label="Loading usage" />
      ) : overview.isError || !overview.data ? (
        <ErrorState message="Usage numbers could not be loaded." onRetry={() => void overview.refetch()} />
      ) : (
        <UsageStrip overview={overview.data} />
      )}
      <MoneyStrip range={range} spend={spend} overview={overview} revenue={revenue} />
    </Stack>
  );
}
