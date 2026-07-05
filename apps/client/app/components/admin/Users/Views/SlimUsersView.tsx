import { IUserDocument, WithOrgRef } from '@bike4mind/common';
import { Button, Card, Grid, Typography, Tooltip, LinearProgress, Box } from '@mui/joy';
import React from 'react';
import AdminProfile from '../../AdminProfile';
import LoginsView from '../LoginsView';
import MFAStatusBadge from '../MFAStatusBadge';
import { useFullUserViewModal } from '@client/app/components/admin/Users/Views/FullUserViewModal';
import { useGetRecentActivities } from '@client/app/hooks/data/user';
import { useMemo } from 'react';
import prettyBytes from 'pretty-bytes';
import { computeStoragePercent } from './storageUtils';

interface SlimUsersViewProps {
  user: WithOrgRef<IUserDocument>;
  index: number;
}

interface SlimUsersContainerProps {
  users: WithOrgRef<IUserDocument>[];
}

const SlimUsersViewHeader: React.FC = () => {
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
        overflowX: { xs: 'auto', sm: 'visible' },
      }}
    >
      <Grid
        container
        spacing={2}
        sx={{ width: '100%', minWidth: { xs: '800px', sm: 'auto' } }}
        justifyContent={'center'}
        alignItems={'center'}
      >
        <Grid xs={1.5}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Name
          </Typography>
        </Grid>
        <Grid xs={1.5}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            User ID
          </Typography>
        </Grid>
        <Grid xs={2.5}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Email
          </Typography>
        </Grid>
        <Grid xs={1}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Logins
          </Typography>
        </Grid>
        <Grid xs={1.5}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Storage
          </Typography>
        </Grid>
        <Grid xs={1}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Security
          </Typography>
        </Grid>
        <Grid xs={1}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Recent Activity
          </Typography>
        </Grid>
        <Grid xs={2}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary' }}>
            Actions
          </Typography>
        </Grid>
      </Grid>
    </Card>
  );
};

const SlimUsersView: React.FC<SlimUsersViewProps> = ({ user, index }) => {
  const setFullUserViewUserId = useFullUserViewModal(state => state.setUserId);
  const recentActivities = useGetRecentActivities({ coverage: 'all', userId: user.id });
  const latestActivity = useMemo(() => recentActivities.data?.slice(0, 1) ?? [], [recentActivities.data]);

  const storageLimitBytes = user.storageLimit * 1024 * 1024;
  const storagePercent = computeStoragePercent(user.currentStorageSize, user.storageLimit);

  return (
    <Card
      variant="outlined"
      key={index}
      data-testid="admin-user-card"
      sx={{
        mb: 1,
        width: '100%',
        bgcolor: index % 2 ? 'background.level1' : 'background.level2',
        p: { xs: 0.5, sm: 1 },
        overflowX: { xs: 'auto', sm: 'visible' },
      }}
    >
      <Grid
        container
        spacing={2}
        sx={{ width: '100%', minWidth: { xs: '800px', sm: 'auto' } }}
        justifyContent={'center'}
        alignItems={'center'}
      >
        {/* Name, User Name, Organization, Email */}
        <Grid xs={1.5}>
          <Tooltip title={user.name} placement="top">
            <Typography
              level="body-sm"
              sx={{
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                cursor: 'help',
                fontWeight: 500,
              }}
              data-testid={`user-name-${user.name}`}
            >
              {user.name.length > 15 ? `${user.name.substring(0, 15)}...` : user.name}
            </Typography>
          </Tooltip>
        </Grid>

        <Grid xs={1.5}>
          <Typography
            level="body-xs"
            sx={{
              wordBreak: 'break-all',
              fontFamily: 'monospace',
              color: 'text.tertiary',
              fontSize: '10px',
            }}
          >
            {user.id}
          </Typography>
        </Grid>

        <Grid xs={2.5}>
          <Typography
            level="body-sm"
            sx={{
              wordBreak: 'break-all',
              color: 'text.secondary',
            }}
          >
            {user.email}
          </Typography>
        </Grid>

        <Grid xs={1}>
          <LoginsView user={user} />
        </Grid>

        <Grid xs={1.5}>
          <Tooltip
            title={`${prettyBytes(user.currentStorageSize || 0)} / ${prettyBytes(storageLimitBytes)}`}
            placement="top"
          >
            <Box sx={{ width: '100%', px: 1 }}>
              <LinearProgress
                determinate
                thickness={20}
                value={storagePercent}
                sx={{
                  '--LinearProgress-progressThickness': '16px',
                  borderRadius: '4px',
                  border: '1px solid',
                  borderColor: 'neutral.outlinedBorder',
                  height: '16px',
                  backgroundColor: 'background.level2',
                }}
                color={storagePercent >= 90 ? 'danger' : storagePercent >= 75 ? 'warning' : 'primary'}
              >
                <Typography
                  level="body-xs"
                  sx={{
                    fontSize: '9px',
                    mixBlendMode: 'normal',
                    color: 'text.primary',
                    fontWeight: 500,
                    zIndex: 2,
                  }}
                >
                  {Math.round(storagePercent)}%
                </Typography>
              </LinearProgress>
            </Box>
          </Tooltip>
        </Grid>

        <Grid xs={1}>
          <MFAStatusBadge user={user} />
        </Grid>

        <Grid xs={1}>
          {latestActivity[0] ? (
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {new Date(latestActivity[0].datetime).toDateString()} {latestActivity[0].counterName}
            </Typography>
          ) : (
            <Typography level="body-xs" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
              No activity
            </Typography>
          )}
        </Grid>

        <Grid xs={2} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button data-testid="admin-user-admin-btn" size="sm" onClick={() => setFullUserViewUserId(user.id)}>
            Admin
          </Button>
          <AdminProfile userId={user.id} size="sm" />
        </Grid>
      </Grid>
    </Card>
  );
};

const SlimUsersContainer: React.FC<SlimUsersContainerProps> = ({ users }) => {
  return (
    <>
      <SlimUsersViewHeader />
      {users.map((user, index) => (
        <SlimUsersView user={user} index={index} key={user.id} />
      ))}
    </>
  );
};

export default SlimUsersContainer;
