import { useFullUserViewModal } from '@client/app/components/admin/Users/Views/FullUserViewModal';
import { useGetRecentActivities } from '@client/app/hooks/data/user';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { Box, Button, Card, Grid, LinearProgress, Stack, Tooltip, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import React, { useMemo } from 'react';
import AdminProfile from '../../AdminProfile';
import LoginsView from '../LoginsView';
import MFAStatusBadge from '../MFAStatusBadge';
import UserIdChip from '../UserIdChip';
import { computeStoragePercent } from './storageUtils';

interface SlimUsersViewProps {
  user: AdminUserListItem;
  index: number;
}

interface SlimUsersContainerProps {
  users: AdminUserListItem[];
}

/** Header and row share these widths; they must be edited together or the table skews. */
const COLUMN_WIDTHS = {
  name: 2,
  userId: 1.25,
  email: 2.25,
  logins: 0.75,
  storage: 1.25,
  security: 1,
  activity: 1.5,
  actions: 2,
} as const;

const ELLIPSIS_SX = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

const StorageCell: React.FC<{ user: AdminUserListItem }> = ({ user }) => {
  const storageLimitBytes = user.storageLimit * 1024 * 1024;
  const storagePercent = computeStoragePercent(user.currentStorageSize, user.storageLimit);
  // Below 1% a percentage reads as "no data"; show the raw size so the cell stays meaningful.
  const label = storagePercent < 1 ? prettyBytes(user.currentStorageSize || 0) : `${Math.round(storagePercent)}%`;

  return (
    <Tooltip title={`${prettyBytes(user.currentStorageSize || 0)} / ${prettyBytes(storageLimitBytes)}`} placement="top">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ cursor: 'help' }}>
        <LinearProgress
          determinate
          thickness={6}
          value={storagePercent}
          color={storagePercent >= 90 ? 'danger' : storagePercent >= 75 ? 'warning' : 'primary'}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <Typography level="body-xs" sx={{ color: 'text.secondary', flexShrink: 0 }}>
          {label}
        </Typography>
      </Stack>
    </Tooltip>
  );
};

const useLatestActivity = (userId: string) => {
  const recentActivities = useGetRecentActivities({ coverage: 'all', userId });
  return useMemo(() => recentActivities.data?.[0], [recentActivities.data]);
};

const RecentActivityCell: React.FC<{ userId: string }> = ({ userId }) => {
  const latestActivity = useLatestActivity(userId);

  if (!latestActivity) {
    return (
      <Typography level="body-xs" sx={{ color: 'text.tertiary', fontStyle: 'italic', ...ELLIPSIS_SX }}>
        No activity
      </Typography>
    );
  }

  return (
    <Tooltip
      title={`${new Date(latestActivity.datetime).toLocaleString()} - ${latestActivity.counterName}`}
      placement="top"
    >
      <Typography level="body-xs" sx={{ color: 'text.secondary', cursor: 'help', ...ELLIPSIS_SX }}>
        {relativeTimeFormat(new Date(latestActivity.datetime))}
      </Typography>
    </Tooltip>
  );
};

const UserActions: React.FC<{ userId: string }> = ({ userId }) => {
  const setFullUserViewUserId = useFullUserViewModal(state => state.setUserId);

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
      <Button data-testid="admin-user-admin-btn" size="sm" onClick={() => setFullUserViewUserId(userId)}>
        Admin
      </Button>
      <AdminProfile userId={userId} size="sm" />
    </Stack>
  );
};

const SlimUsersViewHeader: React.FC = () => (
  <Card
    variant="outlined"
    sx={{
      mb: 1,
      width: '100%',
      bgcolor: 'background.surface',
      p: 1,
      position: 'sticky',
      top: 0,
      zIndex: 1,
      borderBottom: 2,
      borderColor: 'divider',
    }}
  >
    <Grid container spacing={2} sx={{ width: '100%' }} alignItems="center">
      {(
        [
          ['Name', COLUMN_WIDTHS.name],
          ['User ID', COLUMN_WIDTHS.userId],
          ['Email', COLUMN_WIDTHS.email],
          ['Logins', COLUMN_WIDTHS.logins],
          ['Storage', COLUMN_WIDTHS.storage],
          ['Security', COLUMN_WIDTHS.security],
          ['Recent Activity', COLUMN_WIDTHS.activity],
          ['Actions', COLUMN_WIDTHS.actions],
        ] as const
      ).map(([label, width]) => (
        <Grid key={label} xs={width}>
          <Typography level="title-sm" sx={{ fontWeight: 600, color: 'text.primary', ...ELLIPSIS_SX }}>
            {label}
          </Typography>
        </Grid>
      ))}
    </Grid>
  </Card>
);

const SlimUsersView: React.FC<SlimUsersViewProps> = ({ user, index }) => (
  <Card
    variant="outlined"
    data-testid="admin-user-card"
    sx={{
      mb: 1,
      width: '100%',
      bgcolor: index % 2 ? 'background.level1' : 'background.level2',
      p: 1,
    }}
  >
    <Grid container spacing={2} sx={{ width: '100%' }} alignItems="center">
      <Grid xs={COLUMN_WIDTHS.name}>
        <Tooltip title={user.name} placement="top">
          <Typography
            level="body-sm"
            sx={{ cursor: 'help', fontWeight: 500, ...ELLIPSIS_SX }}
            data-testid={`user-name-${user.name}`}
          >
            {user.name}
          </Typography>
        </Tooltip>
      </Grid>

      <Grid xs={COLUMN_WIDTHS.userId} sx={{ minWidth: 0 }}>
        <UserIdChip userId={user.id} />
      </Grid>

      <Grid xs={COLUMN_WIDTHS.email} sx={{ minWidth: 0 }}>
        <Tooltip title={user.email} placement="top">
          <Typography level="body-sm" sx={{ color: 'text.secondary', cursor: 'help', ...ELLIPSIS_SX }}>
            {user.email}
          </Typography>
        </Tooltip>
      </Grid>

      <Grid xs={COLUMN_WIDTHS.logins}>
        <LoginsView user={user} />
      </Grid>

      <Grid xs={COLUMN_WIDTHS.storage}>
        <StorageCell user={user} />
      </Grid>

      <Grid xs={COLUMN_WIDTHS.security}>
        <MFAStatusBadge user={user} />
      </Grid>

      <Grid xs={COLUMN_WIDTHS.activity} sx={{ minWidth: 0 }}>
        <RecentActivityCell userId={user.id} />
      </Grid>

      <Grid xs={COLUMN_WIDTHS.actions}>
        <UserActions userId={user.id} />
      </Grid>
    </Grid>
  </Card>
);

/**
 * Phone layout: stacked card instead of the 800px-wide grid, which previously gave every
 * row its own horizontal scrollbar. Storage is omitted here and stays in the Admin modal.
 */
const SlimUserCardMobile: React.FC<SlimUsersViewProps> = ({ user, index }) => (
  <Card
    variant="outlined"
    data-testid="admin-user-card"
    sx={{ mb: 1, width: '100%', bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 1, gap: 1 }}
  >
    <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
      <Box sx={{ minWidth: 0 }}>
        <Typography level="title-sm" data-testid={`user-name-${user.name}`} sx={ELLIPSIS_SX}>
          {user.name}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.secondary', ...ELLIPSIS_SX }}>
          {user.email}
        </Typography>
      </Box>
      <UserActions userId={user.id} />
    </Stack>

    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <UserIdChip userId={user.id} />
      <LoginsView user={user} />
      <MFAStatusBadge user={user} />
      <RecentActivityCell userId={user.id} />
    </Stack>
  </Card>
);

const SlimUsersContainer: React.FC<SlimUsersContainerProps> = ({ users }) => {
  const isMobile = useIsMobile();

  // Rendered conditionally rather than hidden with CSS so row testids never appear twice.
  if (isMobile) {
    return (
      <>
        {users.map((user, index) => (
          <SlimUserCardMobile user={user} index={index} key={user.id} />
        ))}
      </>
    );
  }

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
