import React, { useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Skeleton, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import {
  type AdminRevenueData,
  type RevenuePlanRow,
  type RevenueRange,
  type RevenueTrendPoint,
} from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY, type AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';
import { AnalyticsTermHelp } from '../EventMetrics/components/AnalyticsTermHelp';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  ErrorState,
  SectionCard,
  SegmentedControl,
  StatStrip,
  StatTile,
  StatusChip,
  formatMoney,
  type DataColumn,
} from '../shared';
import { adminFocus } from '../shared/adminStyles';
import { subscriptionsColumns } from '../Subscriptions/subscriptionsColumns';
import { MrrDefinitionHelp, atRiskNote, mrrExclusionNote } from '../Subscriptions/subscriptionsMrr';
import type { SubscriptionsBuiltInView } from '../Subscriptions/subscriptionsListViews';
import type { SubscriptionsListView } from '../Subscriptions/subscriptionsTabSearch';
import { MrrTrendChart } from './MrrTrendChart';
import { formatLongDay, formatShare, formatTrendDay, signedMoney, trendTakeaway } from './revenueFormat';
import { subscriptionsViewSearch } from './revenueLinks';
import { useAdminRevenue } from './useAdminRevenue';

const SELF_HOST_DOCS_URL = 'https://docs.bike4mind.com/self-host/configuration';

const RANGE_OPTIONS: readonly { value: RevenueRange; label: string }[] = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
];

const rangeLabel = (range: RevenueRange) => `Last ${RANGE_OPTIONS.find(option => option.value === range)?.label}`;

// Must stay in sync with docs/admin-subscriptions-spec.md section 5.3 and server/admin/revenue/revenueSnapshot.ts.
const NEW_MRR_DEFINITION =
  'MRR of subscriptions started in the range that count toward MRR today. Upgrades and seat changes are not included.';
const CHURNED_MRR_DEFINITION =
  'MRR of Stripe subscriptions that ended (reached canceled) in the range, at the price they were billed. A scheduled cancel counts when it takes effect.';

const money = (amount: number) => formatMoney(amount, MRR_CURRENCY);
const compactMoney = (amount: number) => formatMoney(amount, MRR_CURRENCY, { compact: true });

const Skeletal = () => <Skeleton variant="text" level="h3" width="4ch" data-testid="admin-stat-skeleton" />;

type OpenView = (viewId: SubscriptionsBuiltInView['id'], filters?: Partial<SubscriptionsListView>) => void;

function RevenueStrip({ data, isError }: { data?: AdminRevenueData; isError: boolean }) {
  const value = (render: (revenue: AdminRevenueData) => ReactNode) =>
    isError ? '\u2014' : data ? render(data) : <Skeletal />;
  const current = data?.current;
  const start = data?.startOfRange;
  const mrrComparison = current
    ? [
        start ? `${signedMoney(current.mrr.amount - start.mrr)} since ${formatTrendDay(start.date)}` : null,
        mrrExclusionNote(current.mrr),
      ]
        .filter(Boolean)
        .join('. ')
    : undefined;
  const range = data ? rangeLabel(data.range) : undefined;
  return (
    <StatStrip aria-label="Revenue totals">
      <StatTile
        label="MRR"
        help={<MrrDefinitionHelp />}
        value={value(revenue => compactMoney(revenue.current.mrr.amount))}
        comparison={mrrComparison || undefined}
      />
      <StatTile label="ARR" value={value(revenue => compactMoney(revenue.current.arr))} comparison="MRR x 12" />
      <StatTile
        label="Paying customers"
        value={value(revenue => revenue.current.payingCount)}
        comparison={current && current.pastDueMrr.amount > 0 ? atRiskNote(current.pastDueMrr) : undefined}
      />
      <StatTile
        label="New MRR"
        help={
          <AnalyticsTermHelp term="New MRR" testId="admin-revenue-new-mrr-help-btn" description={NEW_MRR_DEFINITION} />
        }
        value={value(revenue => compactMoney(revenue.current.newMrr.amount))}
        comparison={range}
      />
      <StatTile
        label="Churned MRR"
        help={
          <AnalyticsTermHelp
            term="Churned MRR"
            testId="admin-revenue-churned-mrr-help-btn"
            description={CHURNED_MRR_DEFINITION}
          />
        }
        value={value(revenue => compactMoney(revenue.current.churnedMrr.amount))}
        comparison={range}
      />
    </StatStrip>
  );
}

const TREND_COLUMNS: DataColumn<RevenueTrendPoint>[] = [
  { id: 'date', label: 'Date (UTC)', render: point => formatLongDay(point.date), sortValue: point => point.date },
  {
    id: 'mrr',
    label: `MRR (${MRR_CURRENCY.toUpperCase()})`,
    numeric: true,
    render: point => money(point.mrr),
    sortValue: point => point.mrr,
  },
  {
    id: 'paying',
    label: 'Paying customers',
    numeric: true,
    render: point => point.payingCount.toLocaleString(),
    sortValue: point => point.payingCount,
  },
];

function MrrTrendSection({ data, loading }: { data?: AdminRevenueData; loading: boolean }) {
  const [asTable, setAsTable] = useState(false);
  const trend = data?.trend ?? [];
  const hasTrend = trend.length > 0;
  let body: ReactNode;
  if (!data || loading) {
    body = (
      <Box sx={{ p: 2 }}>
        <Skeleton
          variant="rectangular"
          height={240}
          sx={{ borderRadius: '8px' }}
          data-testid="admin-revenue-chart-skeleton"
        />
      </Box>
    );
  } else if (!hasTrend) {
    // trendStartsOn is today until the first snapshot; one before the range means the snapshots stopped.
    const notStarted = data.trendStartsOn >= data.from;
    body = (
      <Box data-testid="admin-revenue-trend-empty">
        <EmptyState
          title={
            notStarted
              ? `Trend starts collecting on ${formatLongDay(data.trendStartsOn)}`
              : 'No snapshots in this range'
          }
          description={
            notStarted
              ? 'A snapshot is taken once a day. The numbers above are current.'
              : `Snapshots began on ${formatLongDay(data.trendStartsOn)}, but none fall in this range. The numbers above are current.`
          }
          action={null}
        />
      </Box>
    );
  } else {
    body = (
      <Stack gap={1.5} sx={{ p: 2 }}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="admin-revenue-chart-caption">
          {trendTakeaway(trend)}
        </Typography>
        {asTable ? (
          <DataTable
            label="MRR over time"
            testId="admin-revenue-trend-table"
            rows={trend}
            columns={TREND_COLUMNS}
            getRowId={point => point.date}
            onRetry={() => undefined}
            minWidth="24rem"
          />
        ) : (
          <MrrTrendChart points={trend} />
        )}
      </Stack>
    );
  }
  return (
    <SectionCard
      title="MRR over time"
      body="custom"
      data-testid="admin-revenue-trend"
      action={
        hasTrend && (
          <Button
            size="sm"
            variant="plain"
            onClick={() => setAsTable(previous => !previous)}
            aria-pressed={asTable}
            data-testid="admin-revenue-trend-table-toggle-btn"
            sx={adminFocus}
          >
            {asTable ? 'View as chart' : 'View as table'}
          </Button>
        )
      }
    >
      {body}
    </SectionCard>
  );
}

const planName = (row: RevenuePlanRow) => row.plan.name ?? 'Unknown plan';

function planColumns(): DataColumn<RevenuePlanRow>[] {
  return [
    {
      id: 'plan',
      label: 'Plan',
      render: row =>
        row.plan.name ? (
          row.plan.name
        ) : (
          <Box component="span" title={row.plan.priceId ?? undefined} sx={{ display: 'inline-flex' }}>
            <StatusChip tone="warn" label="Unknown plan" />
          </Box>
        ),
      sortValue: planName,
    },
    {
      id: 'subscriptions',
      label: 'Subscriptions',
      numeric: true,
      render: row => row.subscriptions.toLocaleString(),
      sortValue: row => row.subscriptions,
    },
    {
      id: 'mrr',
      label: `MRR (${MRR_CURRENCY.toUpperCase()})`,
      numeric: true,
      render: row => (
        <Box component="span" title={mrrExclusionNote(row.mrr) ?? undefined}>
          {money(row.mrr.amount)}
        </Box>
      ),
      sortValue: row => row.mrr.amount,
    },
    {
      id: 'share',
      label: 'Share',
      numeric: true,
      render: row =>
        formatShare(row.share) ?? (
          <Box component="span" sx={{ color: 'admin.inkMuted' }}>
            {'\u2014'}
          </Box>
        ),
      sortValue: row => row.share ?? 0,
    },
  ];
}

const AT_RISK_COLUMN_IDS = ['customer', 'plan', 'status', 'mrr'];

const viewFor = (row: AdminSubscriptionRow): SubscriptionsBuiltInView['id'] =>
  row.status === 'past_due' ? 'pastDue' : 'canceling';

function TablesSection({ data, loading, openView }: { data?: AdminRevenueData; loading: boolean; openView: OpenView }) {
  const plans = useMemo(() => planColumns(), []);
  const atRiskColumns = useMemo(
    () =>
      subscriptionsColumns({ now: new Date(), newSince: null }).filter(column =>
        AT_RISK_COLUMN_IDS.includes(column.id)
      ),
    []
  );
  const atRisk = data?.atRisk;
  const ghost = (label: string, testId: string, onClick: () => void) => (
    <Button size="sm" variant="plain" onClick={onClick} data-testid={testId} sx={adminFocus}>
      {label}
    </Button>
  );
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, minWidth: 0 }}>
      <SectionCard
        title="MRR by plan"
        body="custom"
        data-testid="admin-revenue-by-plan"
        action={ghost('View paying', 'admin-revenue-by-plan-view-btn', () => openView('paying'))}
      >
        <DataTable
          label="MRR by plan"
          testId="admin-revenue-by-plan-table"
          rows={data?.byPlan ?? []}
          columns={plans}
          getRowId={row => row.plan.priceId ?? 'none'}
          rowTestId={row => `admin-revenue-plan-row-${row.plan.priceId ?? 'none'}`}
          loading={loading}
          onRetry={() => undefined}
          onRowActivate={row => openView('paying', row.plan.priceId ? { plan: [row.plan.priceId] } : {})}
          pagination={false}
          minWidth="24rem"
          maxHeight="none"
          empty={
            <EmptyState
              title="No paying subscriptions yet"
              description="Paid plans appear here once someone checks out."
              action={ghost('View all subscriptions', 'admin-revenue-by-plan-empty-btn', () => openView('all'))}
            />
          }
        />
      </SectionCard>
      <SectionCard
        title="At risk"
        body="custom"
        data-testid="admin-revenue-at-risk"
        action={
          <Stack direction="row" gap={0.5}>
            {ghost('View past due', 'admin-revenue-at-risk-past-due-btn', () => openView('pastDue'))}
            {ghost('View canceling', 'admin-revenue-at-risk-canceling-btn', () => openView('canceling'))}
          </Stack>
        }
      >
        {atRisk && atRisk.total > 0 && (
          <Typography
            level="body-sm"
            sx={{ color: 'admin.inkMuted', px: 2, pt: 1.5 }}
            data-testid="admin-revenue-at-risk-summary"
          >
            {`${atRiskNote(atRisk.mrr)} across ${atRisk.total.toLocaleString()} past due or canceling` +
              (atRisk.total > atRisk.rows.length ? `, largest ${atRisk.rows.length} shown` : '')}
          </Typography>
        )}
        <DataTable
          label="At risk"
          testId="admin-revenue-at-risk-table"
          rows={atRisk?.rows ?? []}
          columns={atRiskColumns}
          getRowId={row => row.id}
          rowTestId={row => `admin-revenue-at-risk-row-${row.id}`}
          loading={loading}
          onRetry={() => undefined}
          onRowActivate={row => openView(viewFor(row))}
          pagination={false}
          minWidth="30rem"
          maxHeight="none"
          empty={
            <EmptyState
              title="Nothing at risk"
              description="No paying subscription is past due or canceling."
              action={ghost('View paying', 'admin-revenue-at-risk-empty-btn', () => openView('paying'))}
            />
          }
        />
      </SectionCard>
    </Box>
  );
}

const AdminRevenue: React.FC = () => {
  const [range, setRange] = useState<RevenueRange>('30d');
  const query = useAdminRevenue(range);
  const navigate = useNavigate();
  const openView: OpenView = (viewId, filters) =>
    void navigate({ to: '/admin', search: subscriptionsViewSearch(viewId, filters) });

  const response = query.data;
  const data = response?.stripeConfigured ? response : undefined;
  const loading = query.isLoading || (query.isPlaceholderData && query.isFetching);

  const header = (
    <AdminPageHeader
      title="Revenue"
      description={`Monthly recurring revenue from Stripe subscriptions, in ${MRR_CURRENCY.toUpperCase()}.`}
      actions={
        response?.stripeConfigured !== false && (
          <SegmentedControl
            options={RANGE_OPTIONS}
            value={range}
            onChange={setRange}
            aria-label="Revenue range"
            data-testid="admin-revenue-range"
          />
        )
      }
    />
  );

  let content: ReactNode;
  if (response && !response.stripeConfigured) {
    content = (
      <Box data-testid="admin-revenue-stripe-unconfigured">
        <EmptyState
          title="Stripe isn't configured on this deployment"
          description="Revenue comes from Stripe subscriptions. Comps still work without it."
          action={
            <Button
              variant="outlined"
              component="a"
              href={SELF_HOST_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="admin-revenue-self-host-docs-link"
            >
              Read the self-host docs
            </Button>
          }
        />
      </Box>
    );
  } else if (query.isError && !data) {
    content = <ErrorState message="Could not load revenue." onRetry={() => void query.refetch()} />;
  } else {
    content = (
      <>
        <RevenueStrip data={data} isError={query.isError} />
        <MrrTrendSection data={data} loading={loading} />
        <TablesSection data={data} loading={!data} openView={openView} />
      </>
    );
  }

  return (
    <Stack gap={2} sx={{ width: '100%', minWidth: 0, px: { xs: 2, sm: 3 }, py: 2.5 }} data-testid="admin-revenue-tab">
      {header}
      {content}
    </Stack>
  );
};

export default AdminRevenue;
