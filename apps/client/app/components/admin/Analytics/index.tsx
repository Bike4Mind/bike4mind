import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Input, Skeleton, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import type { AnalyticsOverview, AnalyticsOverviewQuery, AnalyticsRange } from '@client/app/utils/analyticsOverview';
import {
  AdminPageHeader,
  SegmentedControl,
  StatSparkline,
  StatStrip,
  StatTile,
  StatusChip,
  useAdminListUrlState,
} from '../shared';
import { adminSearchForTab, type AdminSearch } from '../adminTabParams';
import { ActiveUsersSection } from './ActiveUsersSection';
import { SignupsSection } from './SignupsSection';
import { ANALYTICS_SEARCH_KEYS, readAnalyticsFilters, writeAnalyticsFilters } from './analyticsTabSearch';
import { comparisonLine, formatCount, formatPercent, formatUpdatedAt, sparklineValues } from './analyticsFormat';
import { useAnalyticsOverview } from './useAnalyticsOverview';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const RANGE_OPTIONS = [
  { value: '7d', label: '7d' },
  { value: '28d', label: '28d' },
  { value: '90d', label: '90d' },
  { value: '12m', label: '12m' },
  { value: 'custom', label: 'Custom' },
] as const;
const COMPARE_OPTIONS = [
  { value: 'prev', label: 'Previous period' },
  { value: 'off', label: 'Off' },
] as const;
const SIGNUPS_OPTIONS = [
  { value: 'legit', label: 'Legit only' },
  { value: 'all', label: 'All' },
] as const;

const todayUtc = () => new Date().toISOString().slice(0, 10);
const shiftUtc = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

function StatTiles({ data }: { data: AnalyticsOverview }) {
  const { stats, window } = data;
  const compare = window.previous !== null;
  const days = data.activeUsers.days.filter(day => !day.partial);
  const line = (value: number | null, previous: number | null, unit?: 'points') =>
    compare ? comparisonLine(value, previous, window.completeDays, unit) : undefined;
  const signupsLabel = data.signupsMode === 'legit' ? 'New signups (legit)' : 'New signups (all)';
  const signupSeries = data.signups.buckets
    .filter(bucket => !bucket.partial)
    .map(bucket =>
      bucket.legit === null
        ? null
        : data.signupsMode === 'legit'
          ? bucket.legit
          : bucket.legit + (bucket.suspected ?? 0) + (bucket.unclassified ?? 0)
    );
  const stickinessSeries = days.map(day => (day.dau !== null && day.mau ? (day.dau / day.mau) * 100 : null));

  return (
    <>
      <StatTile
        label="Active users (MAU)"
        value={formatCount(stats.mau.value)}
        comparison={line(stats.mau.value, stats.mau.previous)}
        sparkline={<StatSparkline values={sparklineValues(days.map(d => d.mau))} label="MAU per day" />}
      />
      <StatTile
        label="Daily active (avg)"
        value={formatCount(stats.avgDau.value)}
        comparison={line(stats.avgDau.value, stats.avgDau.previous)}
        sparkline={<StatSparkline values={sparklineValues(days.map(d => d.dau))} label="DAU per day" />}
      />
      <StatTile
        label="Stickiness (DAU / MAU)"
        value={formatPercent(stats.stickiness.value)}
        comparison={line(stats.stickiness.value, stats.stickiness.previous, 'points')}
        sparkline={<StatSparkline values={sparklineValues(stickinessSeries)} label="Stickiness per day" />}
      />
      <StatTile
        label={signupsLabel}
        value={formatCount(stats.newSignups.value)}
        comparison={
          <>
            {`${formatCount(stats.newSignups.suspected)} suspected`}
            {compare && (
              <>
                <br />
                {line(stats.newSignups.value, stats.newSignups.previous)}
              </>
            )}
          </>
        }
        sparkline={<StatSparkline values={sparklineValues(signupSeries)} label="Signups per bucket" />}
      />
      <StatTile label="Activation rate" value="-" comparison="Coming soon" />
    </>
  );
}

function StatSkeletons() {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        <Stack key={index} gap={1} sx={{ px: 2, py: 1.75 }} data-testid="analytics-stat-skeleton">
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="rectangular" height={28} />
          <Skeleton variant="text" width="80%" />
        </Stack>
      ))}
    </>
  );
}

const AnalyticsTab = () => {
  const navigate = useNavigate();
  const [urlState, updateUrl] = useAdminListUrlState(ANALYTICS_SEARCH_KEYS);
  const query = readAnalyticsFilters(urlState.filters);
  const [showMissing, setShowMissing] = useState(false);

  const customIncomplete = query.range === 'custom' && (!query.from || !query.to);
  const customInverted = query.range === 'custom' && !!query.from && !!query.to && query.from > query.to;
  const { data, isPending, isError, refetch } = useAnalyticsOverview(query, !customIncomplete && !customInverted);

  const setQuery = (patch: Partial<AnalyticsOverviewQuery>) =>
    updateUrl({ filters: writeAnalyticsFilters({ ...query, ...patch }) });
  const setRange = (range: AnalyticsRange) => {
    if (range !== 'custom') return setQuery({ range, from: undefined, to: undefined });
    // Seed the date inputs with the range on screen, so Custom starts from what the admin is looking at.
    const to = data?.window.to ?? todayUtc();
    setQuery({ range, from: data?.window.from ?? shiftUtc(to, -27), to });
  };
  const showDefaultRange = query.range === '90d' ? undefined : () => setRange('90d');
  const openSignupWindow = (window: { createdFrom: string; createdTo: string }) =>
    void navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({ ...adminSearchForTab(previous, ADMIN_USERS_TAB_SLUG), ...window }),
    });

  // Pending also covers a custom range still waiting for its dates.
  const loading = isPending && !isError;
  const sectionProps = {
    data,
    loading,
    error: isError,
    onRetry: () => void refetch(),
    onShowDefaultRange: showDefaultRange,
  };
  const missing = data?.missingDays ?? [];

  return (
    <Stack gap={2.5} sx={{ p: { xs: 2, md: 4 }, minWidth: 0 }} data-testid="analytics-page">
      <AdminPageHeader
        title="Analytics"
        description="Who uses Bike4Mind, how often, and whether they come back. UTC."
        actions={<ContextHelpButton helpId="admin/analytics" tooltipText="Analytics help" />}
      />

      <Stack
        direction="row"
        flexWrap="wrap"
        alignItems="center"
        gap={2}
        role="toolbar"
        aria-label="Analytics filters"
        data-testid="analytics-toolbar"
      >
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={query.range}
          onChange={setRange}
          aria-label="Date range"
          data-testid="analytics-range"
        />
        {query.range === 'custom' && (
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Input
              type="date"
              size="sm"
              value={query.from ?? ''}
              onChange={event => setQuery({ from: event.target.value || undefined })}
              slotProps={{ input: { 'aria-label': 'Start date (UTC)', max: todayUtc() } }}
              data-testid="analytics-custom-from-input"
            />
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              to
            </Typography>
            <Input
              type="date"
              size="sm"
              value={query.to ?? ''}
              onChange={event => setQuery({ to: event.target.value || undefined })}
              slotProps={{ input: { 'aria-label': 'End date (UTC)', max: todayUtc() } }}
              data-testid="analytics-custom-to-input"
            />
          </Stack>
        )}
        <ToolbarGroup label="Compare">
          <SegmentedControl
            options={COMPARE_OPTIONS}
            value={query.compare}
            onChange={compare => setQuery({ compare })}
            aria-label="Compare to"
            data-testid="analytics-compare"
          />
        </ToolbarGroup>
        <ToolbarGroup label="Signups">
          <SegmentedControl
            options={SIGNUPS_OPTIONS}
            value={query.signups}
            onChange={signups => setQuery({ signups })}
            aria-label="Signups counted"
            data-testid="analytics-signups-mode"
          />
        </ToolbarGroup>
        {data && (
          <Stack direction="row" alignItems="center" gap={1} sx={{ ml: { md: 'auto' } }}>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="analytics-last-updated">
              {data.lastUpdated ? `Last updated ${formatUpdatedAt(data.lastUpdated)}` : 'No rollup yet'}
            </Typography>
            {data.stale && <StatusChip tone="warn" label="Stale" data-testid="analytics-stale-chip" />}
          </Stack>
        )}
      </Stack>

      {(customIncomplete || customInverted) && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="analytics-custom-hint">
          {customInverted
            ? 'Pick a start date on or before the end date.'
            : 'Pick a start and an end date (inclusive UTC days).'}
        </Typography>
      )}

      {missing.length > 0 && (
        <Alert
          color="warning"
          variant="soft"
          data-testid="analytics-missing-banner"
          endDecorator={
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => setShowMissing(value => !value)}
              data-testid="analytics-missing-toggle-btn"
            >
              {showMissing ? 'Hide missing days' : 'Show missing days'}
            </Button>
          }
        >
          <Box>
            <Typography level="body-sm">
              {`Rollup is missing for ${missing.length} ${missing.length === 1 ? 'day' : 'days'}; those days show as gaps.`}
            </Typography>
            {showMissing && (
              <Typography level="body-xs" sx={{ mt: 0.5 }} data-testid="analytics-missing-days">
                {missing.join(', ')}
              </Typography>
            )}
          </Box>
        </Alert>
      )}

      <StatStrip aria-label="Key numbers">{data && !isError ? <StatTiles data={data} /> : <StatSkeletons />}</StatStrip>
      {data?.window.partialDay && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: -1.5 }}>
          {`Tiles cover the ${data.window.completeDays} complete UTC days; today is still counting and is left out.`}
        </Typography>
      )}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
        }}
      >
        <ActiveUsersSection {...sectionProps} />
        <SignupsSection {...sectionProps} onSelectWindow={openSignupWindow} />
      </Box>

      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="analytics-footer">
        Counts exclude staff, system and test accounts. Days are UTC.
      </Typography>
    </Stack>
  );
};

export default AnalyticsTab;
