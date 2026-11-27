import { useMemo, useState } from 'react';
import { Link as RouterLink } from '@tanstack/react-router';
import { Button, Stack, Typography } from '@mui/joy';
import {
  FEATURE_SPIKE_TRAILING_DAYS,
  type SpendAudience,
  type SpendFeatureRow,
  type SpendFeaturesResponse,
  type SpendFeatureUserRow,
} from '@bike4mind/common';
import {
  AdminPageHeader,
  DataTable,
  SectionCard,
  SegmentedControl,
  StatSparkline,
  StatusChip,
  UpdatingBar,
  type DataColumn,
} from '../shared';
import { seriesLabel } from './seriesLabels';
import { formatShare, formatUsd, type SpendRange } from './spendExplorerModel';
import { useSpendFeatures, useSpendFeatureUsers } from './useFeatureCost';

const AUDIENCE_OPTIONS: ReadonlyArray<{ value: SpendAudience; label: string }> = [
  { value: 'all', label: 'Everyone' },
  { value: 'external', label: 'External' },
  { value: 'internal', label: 'Internal' },
];

const DEFAULT_PAGE_SIZE = 25;
// About what a 128px sparkline cell can draw: past this, days fold into multi-day bars.
const MAX_TREND_BARS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const formatCount = (value: number) => numberFormat.format(value);
const featureLabel = (feature: string) => seriesLabel('feature', feature);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

export type FeatureCostSelection = { audience: SpendAudience; feature: string | null; user: string | null };

type FeatureCostSectionProps = {
  range: SpendRange;
  rangeLabel: string;
  selection: FeatureCostSelection;
  onChange: (patch: Partial<FeatureCostSelection>) => void;
};

function SpikeChip({ testId }: { testId: string }) {
  return <StatusChip tone="bad" label="Spike" data-testid={testId} />;
}

/** "-" for a feature with no meaningful unit, else "1,204 seconds". */
function formatUnits(units: number, unitLabel: string | null): string {
  return unitLabel === null ? '-' : `${formatCount(units)} ${unitLabel}`;
}

/** Folds a daily series into at most `maxBars` sums of `daysPerBar` consecutive days. */
export function foldDailySeries(values: number[], maxBars: number): { bars: number[]; daysPerBar: number } {
  const daysPerBar = Math.max(1, Math.ceil(values.length / maxBars));
  const bars: number[] = [];
  for (let i = 0; i < values.length; i += daysPerBar) {
    bars.push(values.slice(i, i + daysPerBar).reduce((sum, value) => sum + value, 0));
  }
  return { bars, daysPerBar };
}

function TrendCell({ values, feature }: { values: number[]; feature: string }) {
  const { bars, daysPerBar } = foldDailySeries(values, MAX_TREND_BARS);
  const per = daysPerBar === 1 ? 'day' : `${daysPerBar} days`;
  return <StatSparkline values={bars} label={`${featureLabel(feature)} cost per ${per} over ${values.length} days`} />;
}

function lastDayHelp(spikeMultiple: number | undefined): string {
  const base = `Cost on the last complete UTC day of the range / the average day of the ${FEATURE_SPIKE_TRAILING_DAYS} days before it.`;
  return spikeMultiple === undefined ? base : `${base} A spike is a last day above ${spikeMultiple}x that average.`;
}

/** Columns both feature tables share: the whole platform's, and one user's mix. */
function featureColumns(params: {
  withUsers: boolean;
  spikeMultiple: number | undefined;
}): DataColumn<SpendFeatureRow>[] {
  const columns: DataColumn<SpendFeatureRow>[] = [
    {
      id: 'feature',
      label: 'Feature',
      render: row => (
        <Stack direction="row" gap={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap>
            {featureLabel(row.feature)}
          </Typography>
          {row.isSpike && <SpikeChip testId={`spend-features-spike-chip-${row.feature}`} />}
        </Stack>
      ),
      sortValue: row => featureLabel(row.feature),
    },
    {
      id: 'cost',
      label: 'Cost (USD)',
      numeric: true,
      width: '7rem',
      render: row => formatUsd(row.costUsd),
      sortValue: row => row.costUsd,
    },
    {
      id: 'share',
      label: 'Share',
      numeric: true,
      width: '5rem',
      render: row => formatShare(row.share),
      sortValue: row => row.share,
    },
    {
      id: 'requests',
      label: 'Requests',
      numeric: true,
      width: '7rem',
      render: row => formatCount(row.requests),
      sortValue: row => row.requests,
    },
  ];
  if (params.withUsers) {
    columns.push({
      id: 'users',
      label: 'Users',
      numeric: true,
      width: '5rem',
      render: row => formatCount(row.distinctUsers),
      sortValue: row => row.distinctUsers,
    });
  }
  columns.push(
    {
      id: 'credits',
      label: 'Credits',
      numeric: true,
      width: '6.5rem',
      render: row => formatCount(row.creditsCharged),
      sortValue: row => row.creditsCharged,
    },
    {
      id: 'units',
      label: 'Units',
      numeric: true,
      width: '8.5rem',
      render: row => formatUnits(row.units, row.unitLabel),
    },
    {
      id: 'failed',
      label: 'Failed',
      help: 'Requests that errored or timed out. Errors are left out of cost, credits and units; timeouts keep the provider cost they absorbed.',
      numeric: true,
      width: '6.5rem',
      render: row => formatCount(row.failedRequests),
      sortValue: row => row.failedRequests,
    },
    {
      id: 'trend',
      label: 'Daily cost',
      width: '8rem',
      render: row => <TrendCell values={row.dailyUsd} feature={row.feature} />,
    },
    {
      id: 'lastDay',
      label: 'Last day (USD)',
      help: lastDayHelp(params.spikeMultiple),
      numeric: true,
      width: '10rem',
      render: row => `${formatUsd(row.lastDayUsd)} / ${formatUsd(row.trailingAvgUsd)}`,
      sortValue: row => row.lastDayUsd,
    }
  );
  return columns;
}

function FeatureTable({
  testId,
  label,
  data,
  isLoading,
  isUpdating,
  error,
  onRetry,
  withUsers,
  onSelect,
}: {
  testId: string;
  label: string;
  data: SpendFeaturesResponse | undefined;
  isLoading: boolean;
  isUpdating: boolean;
  error: string | undefined;
  onRetry: () => void;
  withUsers: boolean;
  onSelect?: (row: SpendFeatureRow) => void;
}) {
  const spikeMultiple = data?.spikeMultiple;
  const columns = useMemo(() => featureColumns({ withUsers, spikeMultiple }), [withUsers, spikeMultiple]);
  return (
    <>
      <UpdatingBar active={isUpdating} testId={`${testId}-updating`} />
      <DataTable
        label={label}
        testId={testId}
        rows={data?.features ?? []}
        columns={columns}
        getRowId={row => row.feature}
        rowTestId={row => `${testId}-row-${row.feature}`}
        onRowActivate={onSelect}
        loading={isLoading && !data}
        error={error}
        onRetry={onRetry}
        empty={<Typography level="body-sm">No recorded usage in this range.</Typography>}
        pagination={false}
        framed={false}
        minWidth={withUsers ? '75rem' : '70rem'}
      />
    </>
  );
}

function FeatureUsersPanel({
  range,
  audience,
  feature,
  onSelectUser,
  onBack,
}: {
  range: SpendRange;
  audience: SpendAudience;
  feature: string;
  onSelectUser: (user: SpendFeatureUserRow) => void;
  onBack: () => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const users = useSpendFeatureUsers({ range, audience, feature, page, pageSize });
  const data = users.data;
  const unitLabel = data?.unitLabel ?? null;

  const columns: DataColumn<SpendFeatureUserRow>[] = useMemo(
    () => [
      {
        id: 'name',
        label: 'User',
        render: row => (
          <Stack direction="row" gap={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Typography level="body-sm" noWrap>
              {row.name}
            </Typography>
            {row.isSpike && <SpikeChip testId={`spend-feature-users-spike-chip-${row.userId}`} />}
          </Stack>
        ),
      },
      { id: 'cost', label: 'Cost (USD)', numeric: true, width: '7rem', render: row => formatUsd(row.costUsd) },
      { id: 'share', label: 'Share', numeric: true, width: '5rem', render: row => formatShare(row.share) },
      { id: 'requests', label: 'Requests', numeric: true, width: '7rem', render: row => formatCount(row.requests) },
      {
        id: 'credits',
        label: 'Credits',
        numeric: true,
        width: '6.5rem',
        render: row => formatCount(row.creditsCharged),
      },
      { id: 'units', label: 'Units', numeric: true, width: '8.5rem', render: row => formatUnits(row.units, unitLabel) },
      { id: 'failed', label: 'Failed', numeric: true, width: '6.5rem', render: row => formatCount(row.failedRequests) },
      {
        id: 'lastDay',
        label: 'Last day (USD)',
        numeric: true,
        width: '10rem',
        help: lastDayHelp(data?.spikeMultiple),
        render: row => `${formatUsd(row.lastDayUsd)} / ${formatUsd(row.trailingAvgUsd)}`,
      },
    ],
    [unitLabel, data?.spikeMultiple]
  );

  return (
    <SectionCard
      title={`${featureLabel(feature)}: top users`}
      body="custom"
      data-testid="spend-feature-users-panel"
      action={
        <Button size="sm" variant="plain" onClick={onBack} data-testid="spend-feature-users-back-btn">
          All features
        </Button>
      }
    >
      <UpdatingBar active={users.isFetching && data !== undefined} testId="spend-feature-users-updating" />
      <DataTable
        label={`Top users of ${featureLabel(feature)}`}
        testId="spend-feature-users-table"
        rows={data?.users ?? []}
        columns={columns}
        getRowId={row => row.userId}
        rowTestId={row => `spend-feature-users-row-${row.userId}`}
        onRowActivate={onSelectUser}
        loading={users.isLoading && !data}
        error={users.isError ? `Could not load users: ${errorMessage(users.error)}` : undefined}
        onRetry={() => void users.refetch()}
        empty={<Typography level="body-sm">Nobody used this feature in this range.</Typography>}
        pagination={{
          page,
          pageSize,
          total: data?.totalUsers ?? 0,
          onPageChange: setPage,
          onPageSizeChange: size => {
            setPageSize(size);
            setPage(1);
          },
        }}
        framed={false}
        minWidth="63rem"
      />
    </SectionCard>
  );
}

const isDayAligned = (date: Date) => date.getTime() % DAY_MS === 0;

/** The whole UTC days the server widens a sub-day range to, as `YYYY-MM-DD to YYYY-MM-DD`. */
function wholeDaysLabel(range: SpendRange): string {
  const first = Math.floor(range.from.getTime() / DAY_MS) * DAY_MS;
  const last = Math.ceil(range.to.getTime() / DAY_MS) * DAY_MS - DAY_MS;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return first === last ? day(first) : `${day(first)} to ${day(last)}`;
}

/**
 * One user's feature mix over the range. `onBack` adds a Back button. Where the page already
 * links to the user, `showProfileLink={false}` drops this panel's own link, and `testId`
 * keeps two panels on one page apart.
 */
export function UserFeaturesPanel({
  range,
  userId,
  userName,
  onBack,
  showProfileLink = true,
  testId = 'spend-user-features',
}: {
  range: SpendRange;
  userId: string;
  userName: string | null;
  onBack?: () => void;
  showProfileLink?: boolean;
  testId?: string;
}) {
  // Audience does not apply to one named user: their whole mix is shown.
  const features = useSpendFeatures({ range, audience: 'all', userId });
  const widened = !isDayAligned(range.from) || !isDayAligned(range.to);
  return (
    <SectionCard
      title={`${userName ?? userId}: features used`}
      body="custom"
      data-testid={`${testId}-panel`}
      action={
        <Stack direction="row" gap={1} alignItems="center">
          {showProfileLink && (
            <RouterLink
              to="/admin/users/$userId"
              params={{ userId }}
              data-testid={`${testId}-profile-link`}
              style={{ textDecoration: 'none' }}
            >
              <Typography level="body-sm" sx={{ color: 'admin.link' }}>
                Open user
              </Typography>
            </RouterLink>
          )}
          {onBack && (
            <Button size="sm" variant="plain" onClick={onBack} data-testid={`${testId}-back-btn`}>
              Back
            </Button>
          )}
        </Stack>
      }
    >
      {widened && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid={`${testId}-days-note`}>
          {`Whole UTC days, ${wholeDaysLabel(range)}: feature cost is counted by day, not by hour.`}
        </Typography>
      )}
      <FeatureTable
        testId={`${testId}-table`}
        label={`Features used by ${userName ?? userId}`}
        data={features.data}
        isLoading={features.isLoading}
        isUpdating={features.isFetching && features.data !== undefined}
        error={features.isError ? `Could not load features: ${errorMessage(features.error)}` : undefined}
        onRetry={() => void features.refetch()}
        withUsers={false}
      />
    </SectionCard>
  );
}

/**
 * Cost by feature for the explorer's range: which features drive spend, who uses each one
 * (paged top users) and what each user uses. Selection lives in the URL like the rest of the page.
 */
export function FeatureCostSection({ range, rangeLabel, selection, onChange }: FeatureCostSectionProps) {
  const { audience, feature, user } = selection;
  // The clicked row's name, so the user panel need not look it up again; a pasted link shows the id.
  const [picked, setPicked] = useState<{ userId: string; name: string } | null>(null);
  const userName = picked && picked.userId === user ? picked.name : null;
  // The platform table is hidden while a drill-down panel replaces it, so skip its query then.
  const features = useSpendFeatures({ range, audience, enabled: !user && !feature });

  const body = user ? (
    <UserFeaturesPanel range={range} userId={user} userName={userName} onBack={() => onChange({ user: null })} />
  ) : feature ? (
    <FeatureUsersPanel
      // A new feature, audience or range remounts the panel, so paging starts from page 1.
      key={`${feature}|${audience}|${range.from.toISOString()}|${range.to.toISOString()}`}
      range={range}
      audience={audience}
      feature={feature}
      onSelectUser={row => {
        setPicked({ userId: row.userId, name: row.name });
        onChange({ user: row.userId });
      }}
      onBack={() => onChange({ feature: null })}
    />
  ) : (
    <SectionCard title={`${rangeLabel} UTC`} body="custom" data-testid="spend-features-panel">
      <FeatureTable
        testId="spend-features-table"
        label="Cost by feature"
        data={features.data}
        isLoading={features.isLoading}
        isUpdating={features.isFetching && features.data !== undefined}
        error={features.isError ? `Could not load features: ${errorMessage(features.error)}` : undefined}
        onRetry={() => void features.refetch()}
        withUsers
        onSelect={row => onChange({ feature: row.feature })}
      />
    </SectionCard>
  );

  return (
    <Stack gap={2} data-testid="spend-features">
      <AdminPageHeader
        level="section"
        title="Cost by feature"
        description="Recorded cost per product feature. Errored requests are not counted as spend."
        // One named user's mix ignores the audience, so the control is offered only where it applies.
        actions={
          !user && (
            <SegmentedControl<SpendAudience>
              aria-label="Accounts"
              data-testid="spend-features-audience"
              options={AUDIENCE_OPTIONS}
              value={audience}
              onChange={value => onChange({ audience: value })}
            />
          )
        }
      />
      {body}
    </Stack>
  );
}
