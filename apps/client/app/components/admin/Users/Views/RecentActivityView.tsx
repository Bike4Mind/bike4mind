import { Card, Grid, Stack, Typography, Box } from '@mui/joy';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import React, { useState } from 'react';
import { useGetRecentActivities } from '@client/app/hooks/data/user';

interface RecentActivityViewProps {
  limit?: number;
}

interface IActivityLog {
  userId: string;
  clientIp: string;
  path: string;
  datetime: Date;
}

interface IActivityMetadata {
  clientIp?: string;
  path?: string;
}

const RecentActivityCard: React.FC<{ activity: IActivityLog; index: number }> = ({ activity, index }) => {
  const [mobileExpanded, setMobileExpanded] = useState(false);

  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        width: '100%',
        bgcolor: index % 2 ? 'background.level1' : 'background.level2',
        p: { xs: 0.5, sm: 1 },
      }}
    >
      {/* Mobile compact summary */}
      <Box
        data-testid={`recent-activity-mobile-summary-${index}`}
        role="button"
        tabIndex={0}
        aria-expanded={mobileExpanded}
        onClick={() => setMobileExpanded(prev => !prev)}
        sx={{
          display: { xs: 'flex', sm: 'none' },
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 0.5,
          cursor: 'pointer',
        }}
      >
        <Stack direction="column" sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontWeight={600} noWrap sx={{ fontFamily: 'monospace' }}>
            {activity.path}
          </Typography>
          <Typography level="body-xs" color="neutral" noWrap>
            {new Date(activity.datetime).toLocaleString()}
          </Typography>
        </Stack>
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: 'text.tertiary' }}>
          {mobileExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </Box>
      </Box>

      {/* Mobile expanded details */}
      {mobileExpanded && (
        <Box sx={{ display: { xs: 'block', sm: 'none' }, p: 1 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 60 }}>
                User ID:
              </Typography>
              <Typography level="body-xs" noWrap sx={{ fontFamily: 'monospace' }}>
                {activity.userId}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 60 }}>
                IP:
              </Typography>
              <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                {activity.clientIp}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 60 }}>
                Endpoint:
              </Typography>
              <Typography level="body-xs" noWrap sx={{ fontFamily: 'monospace' }}>
                {activity.path}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 60 }}>
                Time:
              </Typography>
              <Typography level="body-xs">{new Date(activity.datetime).toLocaleString()}</Typography>
            </Stack>
          </Stack>
        </Box>
      )}

      {/* Desktop grid row - hidden on mobile */}
      <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
        <Grid container spacing={2} alignItems="center">
          <Grid xs={3}>
            <Typography
              level="body-md"
              sx={{
                fontFamily: 'monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {activity.userId}
            </Typography>
          </Grid>
          <Grid xs={2}>
            <Typography level="body-md" sx={{ fontFamily: 'monospace' }}>
              {activity.clientIp}
            </Typography>
          </Grid>
          <Grid xs={4}>
            <Typography
              level="body-md"
              sx={{
                fontFamily: 'monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {activity.path}
            </Typography>
          </Grid>
          <Grid xs={3}>
            <Typography level="body-md">{new Date(activity.datetime).toLocaleString()}</Typography>
          </Grid>
        </Grid>
      </Box>
    </Card>
  );
};

const RecentActivityHeader: React.FC = () => {
  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        width: '100%',
        bgcolor: 'background.surface',
        p: { xs: 0.5, sm: 1 },
        position: 'sticky',
        top: 0,
        zIndex: 1,
        borderBottom: 2,
        borderColor: 'divider',
        display: { xs: 'none', sm: 'block' },
      }}
    >
      <Grid container spacing={2} alignItems="center">
        <Grid xs={3}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            User ID
          </Typography>
        </Grid>
        <Grid xs={2}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            IP Address
          </Typography>
        </Grid>
        <Grid xs={4}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Endpoint
          </Typography>
        </Grid>
        <Grid xs={3}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Time
          </Typography>
        </Grid>
      </Grid>
    </Card>
  );
};

const RecentActivityView: React.FC<RecentActivityViewProps> = ({ limit = 10 }) => {
  const recentActivities = useGetRecentActivities({
    coverage: 'all',
    userId: undefined, // This will fetch all users' activities
  });

  const activities: IActivityLog[] =
    recentActivities.data?.map(activity => {
      const metadata = activity.metadata as IActivityMetadata | undefined;
      return {
        userId: activity.userId,
        clientIp: metadata?.clientIp || 'Unknown',
        path: metadata?.path || 'Unknown',
        datetime: activity.datetime,
      };
    }) || [];

  return (
    <Box sx={{ width: '100%' }}>
      {recentActivities.isLoading ? (
        <Typography sx={{ textAlign: 'center', py: 4 }}>Loading activities...</Typography>
      ) : activities.length === 0 ? (
        <Typography sx={{ textAlign: 'center', py: 4 }}>No recent activities found</Typography>
      ) : (
        <>
          <RecentActivityHeader />
          {activities.slice(0, limit).map((activity, index) => (
            <RecentActivityCard key={index} activity={activity} index={index} />
          ))}
        </>
      )}
    </Box>
  );
};

export default RecentActivityView;
