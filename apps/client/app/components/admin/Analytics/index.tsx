import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Input, Skeleton, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import type { ActivationFunnel } from '@client/app/utils/activationFunnel';
import { getErrorMessage } from '@client/app/utils/error';
import type { UserFunnelStep } from '@client/app/utils/adminUsersFilter';
import type {
  AnalyticsAccounts,
  AnalyticsOverview,
  AnalyticsOverviewQuery,
  AnalyticsRange,
  TopAccountRow,
} from '@client/app/utils/analyticsOverview';
import {
  AdminPageHeader,
  SegmentedControl,
  StatSparkline,
  StatStrip,
  StatTile,
  StatusChip,
  useAdminListUrlState,
} from '../shared';
import { ADMIN_ORGANIZATIONS_TAB_SLUG, adminSearchForTab, type AdminSearch } from '../adminTabParams';
import { adminTabToSlug } from '../adminTabSlugs';
import { AdminTab } from '../adminSidebarConfig';
import { ORGS_ORG_ID_PARAM } from '../organizationsTabSearch';
import { ActiveUsersSection } from './ActiveUsersSection';
import { ActivationFunnelSection } from './ActivationFunnelSection';
import { CohortsSection } from './CohortsSection';
import { SignupsSection, type SignupWindowSelection } from './SignupsSection';
import { CreditsSection, FeatureUsageSection, ModelUsageSection } from './UsageSections';
import { TopAccountsSection } from './TopAccountsSection';
import { downloadAnalyticsExport } from './analyticsExport';
import { useAnalyticsTopAccounts } from './useAnalyticsTopAccounts';
import { ANALYTICS_SEARCH_KEYS, readAnalyticsFilters, writeAnalyticsFilters } from './analyticsTabSearch';
import { comparisonLine, formatCount, formatPercent, formatUpdatedAt, sparklineValues } from './analyticsFormat';
import { useActivationFunnel } from './useActivationFunnel';
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
  { value: 'legit', label: 'Real only' },
  { value: 'all', label: 'All' },
] as const;
const ACCOUNTS_OPTIONS = [
  { value: 'external', label: 'External only' },
  { value: 'internal', label: 'Internal only' },
  { value: 'all', label: 'All' },
] as const;
const FOOTERS: Record<AnalyticsAccounts, string> = {
  external:
    'Active users: an AI request that UTC day from the web app, CLI, Desktop or an agent run; internal, Developer-tagged, test, banned and AI-held accounts are not counted. A signup is real when the email is verified, the account is not banned or held, and it made an AI request within 7 days; every other signup, banned or held ones included, is suspected. External API users are shown separately regardless of Accounts and not counted. Days are UTC.',
  internal:
    'Active users count only admin, system, flagged test, staff-domain, Developer-tagged and test-persona accounts; signups, usage and top accounts always exclude them. The separate API series always counts external accounts. Days are UTC.',
  all: 'Active users include admin, system, flagged test, staff-domain, Developer-tagged and test-persona accounts; signups, usage and top accounts always exclude them. The separate API series always counts external accounts. Days are UTC.',
};

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

function StatTiles({ data, funnel }: { data: AnalyticsOverview; funnel: ActivationFunnel | undefined }) {
  const { stats, window } = data;
  const compare = window.previous !== null;
  const days = data.activeUsers.days.filter(day => !day.partial);
  const line = (value: number | null, previous: number | null, unit?: 'points') =>
    compare ? comparisonLine(value, previous, window.completeDays, unit) : undefined;
  const signupsLabel = data.signupsMode === 'legit' ? 'New signups (real)' : 'New signups (all)';
  const signupSeries = data.signups.buckets
    .filter(bucket => !bucket.partial)
    .map(bucket =>
      bucket.legit === null
        ? null
        : data.signupsMode === 'legit'
          ? bucket.legit
          : bucket.legit + (bucket.suspected ?? 0)
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
      <StatTile
        label="Activation rate"
        value={funnel?.status === 'ok' ? formatPercent(funnel.activationRate.value) : '-'}
        comparison={
          funnel?.status === 'rangeTooLong'
            ? `Pick ${funnel.maxDays} days or fewer`
            : funnel?.status === 'ok' && funnel.steps[0].reached === 0 && funnel.tooNew > 0
              ? 'Signups too new to judge'
              : funnel?.status === 'ok' && compare
                ? comparisonLine(
                    funnel.activationRate.value,
                    funnel.activationRate.previous,
                    window.completeDays,
                    'points'
                  )
                : undefined
        }
      />
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
  const queryReady = !customIncomplete && !customInverted;
  const { data, isPending, isError, isPlaceholderData, refetch } = useAnalyticsOverview(query, queryReady);
  const topAccounts = useAnalyticsTopAccounts(query, queryReady);
  const [exporting, setExporting] = useState(false);

  const funnelQuery = useActivationFunnel(query, queryReady);
  const funnelRefused =
    isAxiosError(funnelQuery.error) && funnelQuery.error.response?.status === 422
      ? getErrorMessage(funnelQuery.error)
      : undefined;

  const setQuery = (patch: Partial<AnalyticsOverviewQuery>) =>
    updateUrl({ filters: writeAnalyticsFilters({ ...query, ...patch }) });
  const setRange = (range: AnalyticsRange) => {
    if (range !== 'custom') return setQuery({ range, from: undefined, to: undefined });
    // Seed the date inputs with the range on screen, so Custom starts from what the admin is looking at.
    const to = data?.window.to ?? todayUtc();
    setQuery({ range, from: data?.window.from ?? shiftUtc(to, -27), to });
  };
  const showDefaultRange = query.range === '90d' ? undefined : () => setRange('90d');
  const openSignupWindow = (window: SignupWindowSelection) =>
    void navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...adminSearchForTab(previous, ADMIN_USERS_TAB_SLUG),
        ...window,
        verdict: window.verdict,
      }),
    });

  const openTab = (tab: AdminTab) => {
    const slug = adminTabToSlug(tab);
    if (slug) void navigate({ to: '/admin', search: (previous: AdminSearch) => adminSearchForTab(previous, slug) });
  };
  const openUser = (row: TopAccountRow) => void navigate({ to: '/admin/users/$userId', params: { userId: row.id } });
  const openOrg = (row: TopAccountRow) =>
    void navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...adminSearchForTab(previous, ADMIN_ORGANIZATIONS_TAB_SLUG),
        [ORGS_ORG_ID_PARAM]: row.id,
      }),
    });
  const exportCsv = async () => {
    if (!data) return;
    setExporting(true);
    try {
      await downloadAnalyticsExport(data, topAccounts.data);
    } catch {
      toast.error("Couldn't export the analytics. Try again.");
    } finally {
      setExporting(false);
    }
  };
  const openFunnelStep = (step: UserFunnelStep) => {
    const funnel = funnelQuery.data;
    if (funnel?.status !== 'ok') return;
    void navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...adminSearchForTab(previous, ADMIN_USERS_TAB_SLUG),
        ...funnel.window,
        funnelStep: step,
        verdict: funnel.signups === 'legit' ? ('legit' as const) : undefined,
      }),
    });
  };

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
  const internalMissing = data?.internalMissingDays ?? [];
  const dayCount = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

  return (
    <Stack gap={2.5} sx={{ p: { xs: 2, md: 4 }, minWidth: 0 }} data-testid="analytics-page">
      <AdminPageHeader
        title="Analytics"
        description="Who uses Bike4Mind, how often, and whether they come back. UTC."
        actions={
          <Stack direction="row" gap={1} alignItems="center">
            <Button
              variant="outlined"
              color="neutral"
              size="sm"
              // Placeholder data is the previous range's, so either side could put another range in the zip.
              disabled={
                !data ||
                isError ||
                isPlaceholderData ||
                topAccounts.isPending ||
                topAccounts.isError ||
                topAccounts.isPlaceholderData
              }
              loading={exporting}
              onClick={() => void exportCsv()}
              data-testid="analytics-export-btn"
            >
              Export CSV
            </Button>
            <ContextHelpButton helpId="admin/analytics" tooltipText="Analytics help" />
          </Stack>
        }
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
        <ToolbarGroup label="Accounts">
          <SegmentedControl
            options={ACCOUNTS_OPTIONS}
            value={query.accounts}
            onChange={accounts => setQuery({ accounts })}
            aria-label="Accounts counted"
            data-testid="analytics-accounts-mode"
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

      {(missing.length > 0 || internalMissing.length > 0) && (
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
            {missing.length > 0 && (
              <Typography level="body-sm" data-testid="analytics-missing-rollup">
                {`Rollup is missing for ${dayCount(missing.length)}; those days show as gaps.`}
              </Typography>
            )}
            {internalMissing.length > 0 && (
              <Typography level="body-sm" data-testid="analytics-missing-internal">
                {`Internal counts are missing or incomplete for ${dayCount(internalMissing.length)}; those days show as gaps until the rollup is re-run for them.`}
              </Typography>
            )}
            {showMissing && (
              <Typography level="body-xs" sx={{ mt: 0.5 }} data-testid="analytics-missing-days">
                {[...missing, ...internalMissing].sort().join(', ')}
              </Typography>
            )}
          </Box>
        </Alert>
      )}

      <StatStrip aria-label="Key numbers">
        {data && !isError ? (
          <StatTiles data={data} funnel={funnelQuery.isPlaceholderData ? undefined : funnelQuery.data} />
        ) : (
          <StatSkeletons />
        )}
      </StatStrip>
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
        <ActivationFunnelSection
          data={funnelQuery.data}
          loading={funnelQuery.isPending && !funnelQuery.isError}
          error={funnelQuery.isError && !funnelRefused}
          refused={funnelRefused}
          updating={funnelQuery.isPlaceholderData}
          fetching={funnelQuery.isFetching}
          onRetry={() => void funnelQuery.refetch()}
          onShowDefaultRange={showDefaultRange}
          onSelectStep={openFunnelStep}
        />
        <FeatureUsageSection {...sectionProps} />
        <ModelUsageSection {...sectionProps} onOpenModels={() => openTab(AdminTab.ModelMetrics)} />
        <CreditsSection {...sectionProps} onOpenCredits={() => openTab(AdminTab.CreditAnalytics)} />
        {(['users', 'orgs'] as const).map(kind => (
          <TopAccountsSection
            key={kind}
            kind={kind}
            data={topAccounts.data}
            loading={topAccounts.isPending && !topAccounts.isError}
            error={topAccounts.isError}
            onRetry={() => void topAccounts.refetch()}
            onShowDefaultRange={showDefaultRange}
            onOpen={kind === 'users' ? openUser : openOrg}
          />
        ))}
      </Box>

      <CohortsSection signups={query.signups} />

      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="analytics-footer">
        {FOOTERS[data?.accounts ?? query.accounts]}
      </Typography>
    </Stack>
  );
};

export default AnalyticsTab;
