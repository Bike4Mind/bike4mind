import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { useUser } from '@client/app/contexts/UserContext';
import { AdminTab } from './adminSidebarConfig';
import { canOpenAdminTab } from './adminTabPermissions';
import { AnalyticsTermHelp } from './EventMetrics/components/AnalyticsTermHelp';
import { NewSignupsTile } from './Signups/NewSignupsTile';
import { AiAdvisoryStrip } from './AiAdvisory/AiAdvisoryStrip';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { AdminPageHeader, LoadingState, SectionCard, SegmentedControl } from './shared';
import { MorningBriefCard } from './MorningBriefCard';
import { ActiveUsersSection } from './Analytics/ActiveUsersSection';
import { useAnalyticsOverview } from './Analytics/useAnalyticsOverview';
import { ANALYTICS_DEFAULTS } from '@client/app/utils/analyticsOverview';
import { useSpend } from './ModelMetrics/hooks/useSpend';
import { useSpendFeatures } from './SpendExplorer/useFeatureCost';
import { formatUsd } from './SpendExplorer/spendExplorerModel';
import { useAdminRevenueTrend } from './Revenue/useAdminRevenue';
import { DailyAreaChart } from './CreditAnalysis/components/DailyAreaChart';
import { NeedsAttentionStrip } from './Dashboard/NeedsAttentionStrip';
import { JumpBackIn } from './Dashboard/JumpBackIn';
import { PulseSection } from './Dashboard/PulseSection';
import { ModelsByCostCard, TopAccountsCard, TopFeaturesCard } from './Dashboard/UsageBreakdowns';
import { PlatformHealthCard, RevenueMovementCard } from './Dashboard/HealthAndRevenue';
import { DASHBOARD_RANGE_OPTIONS, spendWindow, type DashboardRange } from './Dashboard/dashboardRange';

const twoColumnSx = { display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' } };
const threeColumnSx = { display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' } };

function Region({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <Stack spacing={1}>
      <Typography level="h2">
        {title}
        {help && <AnalyticsTermHelp term={title} description={help} />}
      </Typography>
      {children}
    </Stack>
  );
}

function useDashboardData(range: DashboardRange) {
  const overview = useAnalyticsOverview({ ...ANALYTICS_DEFAULTS, range });
  const spendRange = useMemo(() => spendWindow(range), [range]);
  const spend = useSpend(spendRange);
  const featureRange = useMemo(
    () => ({ from: new Date(spendRange.dateFrom), to: new Date(spendRange.dateTo) }),
    [spendRange]
  );
  const features = useSpendFeatures({ range: featureRange, audience: 'external' });
  const revenue = useAdminRevenueTrend();
  return { overview, spend, features, revenue };
}

type AdminDashboardTabProps = {
  onNavigate: (tab: AdminTab) => void;
};

export default function AdminDashboardTab({ onNavigate }: AdminDashboardTabProps) {
  const { currentUser } = useUser();
  const [range, setRange] = useState<DashboardRange>('7d');
  const { overview, spend, features, revenue } = useDashboardData(range);
  const canOpenTab = useCallback((tab: AdminTab) => canOpenAdminTab(currentUser, tab), [currentUser]);
  const dailyCost = useMemo(
    () => (spend.data?.dailyCost ?? []).map(point => ({ day: point.date, value: point.cost })),
    [spend.data]
  );

  return (
    // overflowX clip: the Joy Grid negative gutters stick out of this wrapper
    <Stack gap={ADMIN_REGION_GAP} sx={{ overflowX: 'clip' }} data-testid="admin-dashboard">
      <AdminPageHeader
        title="Admin dashboard"
        description="What needs a person today, and how Bike4Mind is used, what it costs and what it earns."
        actions={
          <SegmentedControl
            options={DASHBOARD_RANGE_OPTIONS}
            value={range}
            onChange={setRange}
            aria-label="Time range"
            data-testid="admin-dashboard-range"
          />
        }
      />

      <AiAdvisoryStrip />

      <Region title="Needs attention">
        <NeedsAttentionStrip onNavigate={onNavigate} />
      </Region>

      <MorningBriefCard />

      <Region title="Jump back in">
        <JumpBackIn onNavigate={onNavigate} canOpenTab={canOpenTab} />
      </Region>

      <Region
        title="Pulse"
        help="Usage counts external accounts only; cost and credits cover every account, including internal accounts and platform jobs. Each number compares the selected range with the one before it. Usage comes from the nightly analytics rollup (today is live); cost is the provider cost of LLM calls; MRR comes from the daily revenue snapshot."
      >
        <PulseSection range={range} overview={overview} spend={spend} revenue={revenue} />
      </Region>

      <Box sx={twoColumnSx}>
        <ActiveUsersSection
          data={overview.data}
          loading={overview.isLoading}
          error={overview.isError}
          onRetry={() => void overview.refetch()}
        />
        <SectionCard title="LLM cost per day" body="custom" data-testid="admin-dashboard-cost-chart">
          <Box sx={{ p: 2 }}>
            {spend.isLoading ? (
              <LoadingState label="Loading daily cost" />
            ) : spend.isError ? (
              <Typography level="body-sm" color="warning">
                Daily cost could not be loaded.
              </Typography>
            ) : (
              <DailyAreaChart
                data={dailyCost}
                valueLabel="Provider cost"
                formatValue={value => formatUsd(value)}
                color="warning"
                height={220}
                testid="admin-dashboard-cost-area"
              />
            )}
          </Box>
        </SectionCard>
      </Box>

      <Box sx={threeColumnSx}>
        <TopFeaturesCard features={features} onNavigate={onNavigate} />
        <ModelsByCostCard spend={spend} onNavigate={onNavigate} />
        <TopAccountsCard spend={spend} onNavigate={onNavigate} />
      </Box>

      <Box sx={twoColumnSx}>
        <PlatformHealthCard range={range} spend={spend} onNavigate={onNavigate} />
        <RevenueMovementCard range={range} revenue={revenue} onNavigate={onNavigate} />
      </Box>

      <Region
        title="Signups"
        help="New accounts, in your local time. Likely legit excludes accounts the suspected-signup signals flag: one strong signal, such as a burst of accounts on one domain, machine-regular signup cadence or bot traffic, or two weaker ones, such as signing up during a signup spike and never coming back. Suspected accounts are counted separately and can be reviewed on the Users tab."
      >
        <NewSignupsTile onReview={() => onNavigate(AdminTab.Users)} />
      </Region>
    </Stack>
  );
}
