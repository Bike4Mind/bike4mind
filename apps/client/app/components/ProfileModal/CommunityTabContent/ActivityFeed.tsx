import { IActivityDocument } from '@bike4mind/common';
import { formatActivityMessage } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetActivities } from '@client/app/hooks/data/activities';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { ACTIVITY_CONFIG } from '@client/config/activities';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import LinearProgress from '@mui/joy/LinearProgress';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import Typography from '@mui/joy/Typography';
import { useState } from 'react';

interface ActivityFeedProps {
  activities?: IActivityDocument[];
  projectId?: string;
  initialLimit?: number;
}

const ActivityFeed = ({ activities: propActivities, projectId, initialLimit = 10 }: ActivityFeedProps = {}) => {
  const [page, setPage] = useState(1);
  const [limit] = useState(initialLimit);

  const activitiesQuery = useGetActivities({ projectId, page, limit });
  const { currentUser } = useUser();

  const activities = propActivities || activitiesQuery.data?.data || [];
  const meta = activitiesQuery.data?.meta;
  const isPending = !propActivities && activitiesQuery.isPending;
  const isLoadingMore = activitiesQuery.isFetching && page > 1;

  const handleLoadMore = () => {
    if (meta && page < meta.totalPages) {
      setPage(prev => prev + 1);
    }
  };

  if (isPending && page === 1) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <LinearProgress />
      </Box>
    );
  }

  if (!activities?.length) {
    return (
      <Typography level="body-md" color="neutral">
        No activities yet
      </Typography>
    );
  }

  if (!currentUser?.id) return null;

  const getMessage = (activity: IActivityDocument, userId: string): string => {
    const ownerName = activity.ownerId.toString() === userId ? 'You' : activity.ownerName;
    return formatActivityMessage(ACTIVITY_CONFIG[activity.key], {
      performer: ownerName,
      receiver: activity.receiverName || '',
      trackable: activity.trackableName || '',
      ...activity.parameters,
    });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <List sx={{ gap: '10px' }}>
        {activities.map((activity: IActivityDocument) => (
          <ListItem
            key={activity.id}
            sx={theme => ({
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 0.5,
              borderRadius: '10px',
              padding: '10px 20px',
              border: theme.palette.profile.border,
              background: theme.palette.background.body,
            })}
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: '40px 1fr', width: '100%', gap: 1 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                }}
              >
                {(() => {
                  const IconComponent = ACTIVITY_CONFIG[activity.key]?.icon;
                  return IconComponent ? <IconComponent color="primary" sx={{ fontSize: '2em' }} /> : null;
                })()}
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Typography level="body-md">{getMessage(activity, currentUser.id)}</Typography>
                <Typography level="body-sm" color="neutral">
                  {relativeTimeFormat(activity.createdAt)}
                </Typography>
              </Box>
            </Box>
          </ListItem>
        ))}
      </List>

      {meta && page < meta.totalPages && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button
            variant="outlined"
            color="neutral"
            onClick={handleLoadMore}
            disabled={isLoadingMore}
            startDecorator={isLoadingMore ? <CircularProgress size="sm" /> : null}
          >
            {isLoadingMore ? 'Loading...' : 'Load More'}
          </Button>
        </Box>
      )}
    </Box>
  );
};

export default ActivityFeed;
