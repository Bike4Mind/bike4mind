import React from 'react';
import { Avatar, Box, Chip, Stack, Tooltip, Typography } from '@mui/joy';
import type { IUserDocument } from '@bike4mind/common';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { formatAccountAge } from '../formatAccountAge';

/**
 * A user as the profile page has it: GET /api/users/[id] returns the whole document, so fields the
 * list projection leaves out (how the account signed up) are there too. List rows lack them.
 */
export type AdminUserProfile = AdminUserListItem & Partial<Pick<IUserDocument, 'acquisition'>>;

const DateLine: React.FC<{ label: string; value: string | Date | undefined; testId: string }> = ({
  label,
  value,
  testId,
}) => {
  const relative = formatAccountAge(value);
  if (!relative || !value) return null;
  return (
    <Tooltip title={new Date(value).toLocaleString()}>
      <Typography level="body-xs" color="neutral" data-testid={testId}>
        {label} {relative}
      </Typography>
    </Tooltip>
  );
};

/** Identity, state badges and dates of the profile page, with the page's quick actions on the right. */
export const UserProfileHeader: React.FC<{ user: AdminUserProfile; actions: React.ReactNode }> = ({
  user,
  actions,
}) => {
  const signupMethod = user.acquisition?.signupMethod;
  return (
    <Stack
      data-testid="user-profile-header"
      direction={{ xs: 'column', md: 'row' }}
      spacing={2}
      justifyContent="space-between"
      alignItems={{ xs: 'stretch', md: 'flex-start' }}
      sx={{ py: 2 }}
    >
      <Stack direction="row" spacing={2} sx={{ minWidth: 0 }}>
        <Avatar src={user.photoUrl || undefined} alt={user.name} size="lg" />
        <Stack spacing={0.75} sx={{ minWidth: 0 }}>
          <Typography level="h1" sx={{ overflowWrap: 'anywhere' }}>
            {user.name}
          </Typography>
          <Typography level="body-sm" color="neutral" sx={{ overflowWrap: 'anywhere' }}>
            @{user.username} - {user.email}
          </Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
            <Chip
              size="sm"
              variant="soft"
              color={user.emailVerified ? 'success' : 'warning'}
              data-testid="user-profile-badge-email"
            >
              {user.emailVerified ? 'Email verified' : 'Email unverified'}
            </Chip>
            {user.isBanned && (
              <Chip size="sm" variant="solid" color="danger" data-testid="user-profile-badge-banned">
                Banned
              </Chip>
            )}
            {user.isModerated && (
              <Chip size="sm" variant="soft" color="warning" data-testid="user-profile-badge-moderated">
                Moderated
              </Chip>
            )}
            {user.isAdmin && (
              <Chip size="sm" variant="soft" color="primary" data-testid="user-profile-badge-admin">
                Super Admin
              </Chip>
            )}
            <Chip size="sm" variant="outlined" data-testid="user-profile-badge-level">
              {user.level}
            </Chip>
            {/* An update response carries the org unpopulated (a bare id) until the refetch lands. */}
            {typeof user.organizationId === 'object' && user.organizationId?.name && (
              <Chip size="sm" variant="outlined" data-testid="user-profile-badge-org">
                {user.organizationId.name}
              </Chip>
            )}
            {signupMethod && (
              <Chip size="sm" variant="outlined" data-testid="user-profile-badge-signup">
                Signed up via {signupMethod}
              </Chip>
            )}
          </Stack>
          <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
            <DateLine label="Created" value={user.createdAt} testId="user-profile-created" />
            <DateLine label="Last active" value={user.lastActiveAt} testId="user-profile-last-active" />
          </Stack>
        </Stack>
      </Stack>
      <Box sx={{ flexShrink: 0 }}>{actions}</Box>
    </Stack>
  );
};
