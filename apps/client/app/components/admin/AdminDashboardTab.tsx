import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, Box, Button, Card, Grid, LinearProgress, Stack, Typography } from '@mui/joy';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { AdminTab } from './adminSidebarConfig';
import { UsageBySourceCard } from './EventMetrics/components/UsageBySourceCard';
import { OverviewTab } from './EventMetrics/components/OverviewTab';
import { useEventMetrics } from './EventMetrics/hooks/useEventMetrics';
import { processChartData } from './EventMetrics/utils/chartDataProcessor';

const DASHBOARD_SHORTCUTS = [
  {
    tab: AdminTab.EventMetrics,
    title: 'Feature activity',
    description: 'Explore tracked actions and event categories.',
  },
  {
    tab: AdminTab.Analytics,
    title: 'User activity & reports',
    description: 'Investigate user activity and read daily or weekly reports.',
  },
  { tab: AdminTab.ModelMetrics, title: 'Model performance', description: 'Compare model usage, latency, and spend.' },
  {
    tab: AdminTab.CreditAnalytics,
    title: 'Credits & costs',
    description: 'Review credit usage, pricing, and margins.',
  },
  { tab: AdminTab.Users, title: 'Users', description: 'Find accounts and inspect individual user activity.' },
  {
    tab: AdminTab.SystemHealth,
    title: 'System health',
    description: 'Check platform services and operational health.',
  },
] as const;

type AdminDashboardTabProps = {
  onNavigate: (tab: AdminTab) => void;
};

const getActivityWindow = () => ({
  dateFrom: dayjs().startOf('day').subtract(6, 'day').toISOString(),
  dateTo: dayjs().endOf('day').toISOString(),
});

export default function AdminDashboardTab({ onNavigate }: AdminDashboardTabProps) {
  const additionalDashboards = premiumRoutes.flatMap(route =>
    route.adminDashboard ? [{ path: route.path, ...route.adminDashboard }] : []
  );
  const [filters, setFilters] = useState(getActivityWindow);
  const { data: metrics = [], isLoading, isFetching, isError, forceRefresh } = useEventMetrics(filters);

  const refreshActivity = () => {
    const nextWindow = getActivityWindow();
    if (nextWindow.dateFrom !== filters.dateFrom || nextWindow.dateTo !== filters.dateTo) {
      setFilters(nextWindow);
    }
    forceRefresh(nextWindow);
  };

  return (
    <Stack spacing={3} sx={{ p: { xs: 0, sm: 2 }, maxWidth: 1440, mx: 'auto' }} data-testid="admin-dashboard">
      <Box>
        <Typography level="h1">Admin dashboard</Typography>
        <Typography level="body-md" sx={{ mt: 1 }}>
          See how Bike4Mind is being used and jump into the tools behind the numbers.
        </Typography>
      </Box>

      {additionalDashboards.length > 0 && (
        <Box>
          <Typography level="h2" sx={{ mb: 1.5 }}>
            More dashboards
          </Typography>
          <Grid container spacing={2}>
            {additionalDashboards.map(dashboard => (
              <Grid
                xs={12}
                sm={additionalDashboards.length === 1 ? 12 : 6}
                lg={additionalDashboards.length === 1 ? 12 : 4}
                key={dashboard.path}
              >
                <Card variant="soft" color="primary" sx={{ height: '100%' }}>
                  <Typography level="title-lg">{dashboard.label}</Typography>
                  <Typography level="body-sm" sx={{ flex: 1 }}>
                    {dashboard.description}
                  </Typography>
                  <Button
                    component="a"
                    href={dashboard.path}
                    variant="solid"
                    endDecorator={<ArrowForwardIcon />}
                    sx={{ alignSelf: 'flex-start' }}
                    data-testid="admin-dashboard-extension-link"
                    aria-label={`Open ${dashboard.label}`}
                  >
                    Open dashboard
                  </Button>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>
      )}

      <Stack spacing={1}>
        <Typography level="h2">Client usage</Typography>
        <Typography level="body-sm">
          Compare Web, Desktop, CLI, API, agent, and system activity. Only source-tagged events are included; Mobile is
          not yet tracked separately. Users may appear under more than one client.
        </Typography>
        <UsageBySourceCard />
      </Stack>

      <Box>
        <Typography level="h2" sx={{ mb: 1.5 }}>
          Explore admin
        </Typography>
        <Grid container spacing={2}>
          {DASHBOARD_SHORTCUTS.map(shortcut => (
            <Grid xs={12} sm={6} lg={4} key={shortcut.tab}>
              <Card sx={{ height: '100%' }}>
                <Typography level="title-lg">{shortcut.title}</Typography>
                <Typography level="body-sm" sx={{ flex: 1 }}>
                  {shortcut.description}
                </Typography>
                <Button
                  variant="plain"
                  endDecorator={<ArrowForwardIcon />}
                  onClick={() => onNavigate(shortcut.tab)}
                  sx={{ alignSelf: 'flex-start' }}
                  data-testid={`admin-dashboard-open-${shortcut.tab}`}
                  aria-label={`Open ${shortcut.title}`}
                >
                  Open
                </Button>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>

      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <Box>
            <Typography level="h2">Recent activity</Typography>
            <Typography level="body-sm">Last 7 days, including today</Typography>
          </Box>
          <Button
            variant="outlined"
            loading={isFetching}
            onClick={refreshActivity}
            data-testid="admin-dashboard-refresh"
          >
            Refresh activity
          </Button>
        </Stack>
        <Alert variant="soft" color="neutral">
          This snapshot shows up to the latest 1,000 matching events, not total feature adoption. Client usage above has
          its own time range and includes all source-tagged events in that range.
        </Alert>
        {isLoading && <LinearProgress aria-label="Loading recent activity" />}
        {isError && (
          <Alert color="danger" data-testid="admin-dashboard-activity-error">
            Recent activity could not be loaded. Use Refresh activity to try again.
          </Alert>
        )}
        {!isLoading && !isError && metrics.length === 0 && (
          <Typography level="body-md" data-testid="admin-dashboard-activity-empty">
            No tracked activity in the last 7 days.
          </Typography>
        )}
        {!isLoading && !isError && metrics.length > 0 && (
          <OverviewTab metrics={metrics} chartData={processChartData(metrics)} showUsageBySource={false} />
        )}
      </Stack>
    </Stack>
  );
}
