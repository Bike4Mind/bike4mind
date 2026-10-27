import { storageLimitToBytes } from '@bike4mind/common';
import { useOpenUserProfile } from '@client/app/components/admin/Users/Profile/useOpenUserProfile';
import { useGetRecentActivities } from '@client/app/hooks/data/user';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { Box, Button, Card, Checkbox, Grid, LinearProgress, Stack, Tooltip, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import React, { useMemo } from 'react';
import AdminProfile from '../../AdminProfile';
import LoginsView from '../LoginsView';
import MFAStatusBadge from '../MFAStatusBadge';
import UserIdChip from '../UserIdChip';
import { computeStoragePercent } from './storageUtils';
import { formatAccountAge, formatAccountCreatedTitle } from '../formatAccountAge';
import { adminFocus } from '../../shared/adminStyles';
import { isAdminShortcutEvent } from '../../shared/adminKeyboard';

/** Row checkboxes for the bulk abuse response; omitted, the list renders without them. */
export type UserSelection = {
  selectedIds: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  onTogglePage: (userIds: string[], selected: boolean) => void;
};

interface SlimUsersViewProps {
  user: AdminUserListItem;
  index: number;
  selection?: UserSelection;
}

interface SlimUsersContainerProps {
  users: AdminUserListItem[];
  selection?: UserSelection;
}

/** Header and row share these widths; they must be edited together or the table skews. */
// MUI Joy Grid is 12 columns and these must sum to exactly 12, or rows wrap and
// stop lining up with the sticky header. Adding `created` was funded by trimming
// 0.25 from five neighbours rather than appending, which would have overflowed.
const COLUMN_WIDTHS = {
  name: 1.75,
  userId: 1.25,
  email: 2,
  created: 1.25,
  logins: 0.75,
  storage: 1,
  security: 1,
  activity: 1.25,
  actions: 1.75,
} as const;

const ELLIPSIS_SX = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

const selectionKeyDown = (event: React.KeyboardEvent, userId: string, selection?: UserSelection) => {
  if (
    !selection ||
    event.target !== event.currentTarget ||
    event.key.toLowerCase() !== 'x' ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    !isAdminShortcutEvent(event.nativeEvent)
  )
    return;
  event.preventDefault();
  selection.onToggle(userId);
};

const StorageCell: React.FC<{ user: AdminUserListItem }> = ({ user }) => {
  const storageLimitBytes = storageLimitToBytes(user.storageLimit);
  const storagePercent = computeStoragePercent(user.currentStorageSize, user.storageLimit);
  // Below 1% a percentage reads as "no data"; show the raw size so the cell stays meaningful.
  const label = storagePercent < 1 ? prettyBytes(user.currentStorageSize || 0) : `${Math.round(storagePercent)}%`;

  return (
    <Tooltip title={`${prettyBytes(user.currentStorageSize || 0)} / ${prettyBytes(storageLimitBytes)}`} placement="top">
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ cursor: 'help' }}
        data-testid="admin-user-storage-cell"
      >
        <LinearProgress
          data-testid="admin-user-storage-cell-progress"
          determinate
          thickness={6}
          value={storagePercent}
          color={storagePercent >= 90 ? 'danger' : storagePercent >= 75 ? 'warning' : 'primary'}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <Typography
          level="body-xs"
          sx={{ color: 'text.secondary', flexShrink: 0 }}
          data-testid="admin-user-storage-cell-label"
        >
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
  const openUserProfile = useOpenUserProfile();

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
      <Button data-testid="admin-user-admin-btn" size="sm" onClick={() => openUserProfile(userId)}>
        Admin
      </Button>
      <AdminProfile userId={userId} size="sm" />
    </Stack>
  );
};

const RowCheckbox: React.FC<{ user: AdminUserListItem; selection?: UserSelection }> = ({ user, selection }) =>
  selection ? (
    <Checkbox
      size="sm"
      checked={selection.selectedIds.has(user.id)}
      onChange={() => selection.onToggle(user.id)}
      slotProps={{ input: { 'aria-label': `Select ${user.email}`, 'data-testid': 'admin-user-select-checkbox' } }}
    />
  ) : null;

const PageCheckbox: React.FC<{ users: AdminUserListItem[]; selection: UserSelection }> = ({ users, selection }) => {
  const selectedOnPage = users.filter(user => selection.selectedIds.has(user.id)).length;
  const allSelected = users.length > 0 && selectedOnPage === users.length;
  return (
    <Checkbox
      size="sm"
      checked={allSelected}
      indeterminate={selectedOnPage > 0 && !allSelected}
      onChange={() =>
        selection.onTogglePage(
          users.map(user => user.id),
          !allSelected
        )
      }
      slotProps={{
        input: { 'aria-label': 'Select all users on this page', 'data-testid': 'admin-user-select-page-checkbox' },
      }}
    />
  );
};

// One table surface (DESIGN_GUIDE.md, "Tables"): a 38px header and 56px rows split by 1px lines.
const ROW_SX = {
  px: 1.5,
  borderBottom: '1px solid',
  borderColor: 'admin.border',
  display: 'flex',
  alignItems: 'center',
} as const;

const SlimUsersViewHeader: React.FC<SlimUsersContainerProps> = ({ users, selection }) => (
  <Box
    role="row"
    sx={{
      ...ROW_SX,
      minHeight: 38,
      bgcolor: 'admin.surfaceSubtle',
      position: 'sticky',
      top: 0,
      zIndex: 1,
    }}
  >
    <Grid container spacing={2} sx={{ width: '100%' }} alignItems="center">
      {(
        [
          ['Name', COLUMN_WIDTHS.name],
          ['User ID', COLUMN_WIDTHS.userId],
          ['Email', COLUMN_WIDTHS.email],
          ['Created', COLUMN_WIDTHS.created],
          ['Logins', COLUMN_WIDTHS.logins],
          ['Storage', COLUMN_WIDTHS.storage],
          ['Security', COLUMN_WIDTHS.security],
          ['Recent Activity', COLUMN_WIDTHS.activity],
          ['Actions', COLUMN_WIDTHS.actions],
        ] as const
      ).map(([label, width]) => (
        <Grid key={label} xs={width}>
          <Stack direction="row" spacing={1} alignItems="center">
            {label === 'Name' && selection && <PageCheckbox users={users} selection={selection} />}
            <Typography level="body-xs" role="columnheader" sx={{ color: 'admin.inkMuted', ...ELLIPSIS_SX }}>
              {label}
            </Typography>
          </Stack>
        </Grid>
      ))}
    </Grid>
  </Box>
);

const SlimUsersView: React.FC<Omit<SlimUsersViewProps, 'index'>> = ({ user, selection }) => (
  <Box
    role="row"
    data-testid="admin-user-card"
    tabIndex={selection ? 0 : undefined}
    aria-selected={selection ? selection.selectedIds.has(user.id) : undefined}
    aria-keyshortcuts={selection ? 'x' : undefined}
    onKeyDown={event => selectionKeyDown(event, user.id, selection)}
    sx={{
      ...adminFocus,
      ...ROW_SX,
      minHeight: 56,
      '&:last-of-type': { borderBottom: 0 },
      '&:hover': { bgcolor: 'admin.surfaceSubtle' },
    }}
  >
    <Grid container spacing={2} sx={{ width: '100%' }} alignItems="center">
      {/* The checkbox shares the name cell so COLUMN_WIDTHS still sums to 12. */}
      <Grid xs={COLUMN_WIDTHS.name} sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <RowCheckbox user={user} selection={selection} />
          <Tooltip title={user.name} placement="top">
            <Typography
              level="body-sm"
              sx={{ cursor: 'help', fontWeight: 500, ...ELLIPSIS_SX }}
              data-testid={`user-name-${user.name}`}
            >
              {user.name}
            </Typography>
          </Tooltip>
        </Stack>
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

      {/* The table already sorts by createdAt by default (useUsersTabParams), so
          until now it sorted by something the reader could not see. Relative age
          answers "how new is this account" directly; the exact timestamp is on
          hover rather than spending column width. */}
      <Grid xs={COLUMN_WIDTHS.created} sx={{ minWidth: 0 }}>
        {formatAccountAge(user.createdAt) ? (
          <Tooltip title={formatAccountCreatedTitle(user.createdAt) ?? ''} placement="top">
            <Typography
              level="body-sm"
              data-testid="admin-user-created"
              sx={{ color: 'text.secondary', cursor: 'help', ...ELLIPSIS_SX }}
            >
              {formatAccountAge(user.createdAt)}
            </Typography>
          </Tooltip>
        ) : (
          <Typography level="body-xs" sx={{ color: 'text.tertiary', ...ELLIPSIS_SX }}>
            &mdash;
          </Typography>
        )}
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
  </Box>
);

/**
 * Phone layout: stacked card instead of the 800px-wide grid, which previously gave every
 * row its own horizontal scrollbar. Storage is omitted here and stays in the Admin modal.
 */
const SlimUserCardMobile: React.FC<SlimUsersViewProps> = ({ user, index, selection }) => (
  <Card
    variant="outlined"
    data-testid="admin-user-card"
    tabIndex={selection ? 0 : undefined}
    aria-keyshortcuts={selection ? 'x' : undefined}
    onKeyDown={event => selectionKeyDown(event, user.id, selection)}
    sx={{ mb: 1, width: '100%', bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 1, gap: 1 }}
  >
    <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
      <RowCheckbox user={user} selection={selection} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
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

const SlimUsersContainer: React.FC<SlimUsersContainerProps> = ({ users, selection }) => {
  const isMobile = useIsMobile();

  // Rendered conditionally rather than hidden with CSS so row testids never appear twice.
  if (isMobile) {
    return (
      <>
        {users.map((user, index) => (
          <SlimUserCardMobile user={user} index={index} key={user.id} selection={selection} />
        ))}
      </>
    );
  }

  return (
    <Card variant="outlined" role="table" aria-label="Users" sx={{ p: 0, gap: 0, overflow: 'clip' }}>
      <SlimUsersViewHeader users={users} selection={selection} />
      {users.map(user => (
        <SlimUsersView user={user} key={user.id} selection={selection} />
      ))}
    </Card>
  );
};

export default SlimUsersContainer;
