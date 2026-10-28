import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, Box, Button, Card, Grid, LinearProgress, Stack, Typography } from '@mui/joy';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { AdminTab } from './adminSidebarConfig';
import { UsageBySourceCard } from './EventMetrics/components/UsageBySourceCard';
import { AnalyticsTermHelp } from './EventMetrics/components/AnalyticsTermHelp';
import { OverviewTab } from './EventMetrics/components/OverviewTab';
import { useAdminActivitySummary } from './useAdminActivitySummary';
import { NewSignupsTile } from './Signups/NewSignupsTile';

const DASHBOARD_SHORTCUTS = [
  {
    tab: AdminTab.EventMetrics,
    title: 'Feature activity',
    description: 'Explore tracked actions and event categories.',
    help: 'An event is a recorded action, such as sending a message or uploading a file. Event categories group related actions. Counts measure recorded activity, not the number of people using a feature.',
  },
  {
    tab: AdminTab.Analytics,
    title: 'User activity & reports',
    description: 'Investigate user activity and read daily or weekly reports.',
  },
  {
    tab: AdminTab.ModelMetrics,
    title: 'Model performance',
    description: 'Compare AI model usage, response times, and costs.',
    help: 'Models are the AI systems that generate responses. Latency means how long a response takes; spend means the cost of using those models.',
  },
  {
    tab: AdminTab.CreditAnalytics,
    title: 'Credits & costs',
    description: 'Review credits used, prices charged, and underlying costs.',
    help: 'Credits are the units used to pay for activity in Bike4Mind. Margins compare what is charged with the underlying cost of providing that activity.',
  },
  { tab: AdminTab.Users, title: 'Users', description: 'Find accounts and inspect individual user activity.' },
  {
    tab: AdminTab.SystemHealth,
    title: 'System health',
    description: 'Check whether the services behind Bike4Mind are working.',
  },
] as const;

type AdminDashboardTabProps = {
  onNavigate: (tab: AdminTab) => void;
};

export default function AdminDashboardTab({ onNavigate }: AdminDashboardTabProps) {
  const additionalDashboards = useMemo(
    () => premiumRoutes.flatMap(route => (route.adminDashboard ? [{ path: route.path, ...route.adminDashboard }] : [])),
    []
  );
  const { data: activity, isLoading, isFetching, isError, refetch } = useAdminActivitySummary();

  return (
    // overflowX clip: the Joy Grid negative gutters stick out of this wrapper at xs, where it has no padding
    <Stack
      spacing={3}
      sx={{ p: { xs: 0, sm: 2 }, maxWidth: 1440, mx: 'auto', overflowX: 'clip' }}
      data-testid="admin-dashboard"
    >
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
            <AnalyticsTermHelp
              term="More dashboards"
              description="Additional dashboards available from installed features. They may use different metrics and time ranges from this overview."
            />
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
                    component={Link}
                    to={dashboard.path}
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
        <Typography level="h2">
          Signups
          <AnalyticsTermHelp
            term="Signups"
            description="New accounts, in your local time. Likely legit excludes accounts the suspected-signup signals flag: one strong signal, such as a burst of accounts on one domain, machine-regular signup cadence or bot traffic, or two weaker ones, such as signing up during a signup spike and never coming back. Suspected accounts are counted separately and can be reviewed on the Users tab."
          />
        </Typography>
        <NewSignupsTile onReview={() => onNavigate(AdminTab.Users)} />
      </Stack>

      <Stack spacing={1}>
        <Typography level="h2">
          Client usage
          <AnalyticsTermHelp
            term="Client usage"
            description="A client is an app or tool used to access Bike4Mind. CLI means the command-line app used in a terminal; API means access by other software. Agents perform tasks automatically, while system activity comes from background jobs. Sources can also describe how an action started."
          />
        </Typography>
        <Typography level="body-sm">
          Compare activity from apps, connected software, and automated tasks. Only activity with a recorded source is
          included; Mobile is not yet tracked separately. Users may appear in more than one source.
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
                <Typography level="title-lg">
                  {shortcut.title}
                  {'help' in shortcut && <AnalyticsTermHelp term={shortcut.title} description={shortcut.help} />}
                </Typography>
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
            <Typography level="h2">
              Recent activity
              <AnalyticsTermHelp
                term="Recent activity"
                description="Counts all recorded events in the last seven UTC calendar days, including today. Today is still in progress. One person can generate many events, so these charts cannot establish overall feature adoption. Refresh activity reloads this summary only."
              />
            </Typography>
            <Typography level="body-sm">Last 7 calendar days (UTC), including today</Typography>
          </Box>
          <Button
            variant="outlined"
            loading={isFetching}
            onClick={() => void refetch()}
            data-testid="admin-dashboard-refresh"
          >
            Refresh activity
          </Button>
        </Stack>
        <Alert variant="soft" color="neutral">
          These charts count all recorded events in this window, not distinct people or overall feature adoption. Today
          is still in progress. Client usage above has its own time range.
        </Alert>
        {isLoading && <LinearProgress aria-label="Loading recent activity" />}
        {isError && (
          <Alert color="danger" data-testid="admin-dashboard-activity-error">
            Recent activity could not be loaded. Use Refresh activity to try again.
          </Alert>
        )}
        {!isLoading && !isError && activity?.totalEvents === 0 && (
          <Typography level="body-md" data-testid="admin-dashboard-activity-empty">
            No tracked activity in the last 7 calendar days (UTC).
          </Typography>
        )}
        {!isLoading && activity && activity.totalEvents > 0 && (
          <OverviewTab chartData={activity} showUsageBySource={false} isCompleteWindow />
        )}
      </Stack>
    </Stack>
  );
}
