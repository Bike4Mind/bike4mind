import React from 'react';
import { hasAdminPermission, isThrottleExempt } from '@bike4mind/common';
import { Avatar, Button, Dropdown, ListDivider, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useUser } from '@client/app/contexts/UserContext';
import { EntityHeader, StatusChip } from '../../shared';
import { AdminPermissionAction } from '../../shared/MissingPermission';
import type { ProfileAction } from './actions/profileActions';
import {
  LEVEL_LABELS,
  accountStatus,
  adminActionBlockedReason,
  displayName,
  initials,
  organizationName,
  type AdminUserProfile,
} from './userProfileModel';

type MenuEntry =
  | { action: ProfileAction | 'compliance'; label: string; danger?: boolean; disabled?: boolean; hint?: string }
  | 'divider';

type AdminIdentity = Parameters<typeof hasAdminPermission>[0];

/** Mirrors the server gate on the deletion routes: `users:delete`, and full admin for a target with admin access. */
export const deletionBlockedReason = (actor: AdminIdentity, target: AdminUserProfile): string | null =>
  adminActionBlockedReason(actor, target, 'users:delete');

/** Suspend, restrict and limited tier require users:moderate and a permitted target. */
export const moderationBlockedReason = (actor: AdminIdentity, target: AdminUserProfile): string | null =>
  adminActionBlockedReason(actor, target, 'users:moderate');

const gateEntry = (entry: Exclude<MenuEntry, 'divider'>, blocked: string | null): MenuEntry =>
  blocked ? { ...entry, disabled: true, hint: blocked } : entry;

const menuEntries = (
  user: AdminUserProfile,
  deletionBlocked: string | null,
  loginAsBlocked: string | null,
  moderationBlocked: string | null
): MenuEntry[] => [
  { action: 'editProfile', label: 'Edit profile' },
  gateEntry({ action: 'loginAs', label: 'Log in as user' }, loginAsBlocked),
  { action: 'message', label: 'Send message' },
  { action: 'subscription', label: 'Grant subscription' },
  { action: 'role', label: 'Change role' },
  { action: 'productAccess', label: 'Manage product access' },
  'divider',
  { action: 'compliance', label: 'Compliance record' },
  gateEntry(
    { action: 'restrict', label: user.isModerated ? 'Lift restriction' : 'Restrict account' },
    moderationBlocked
  ),
  gateEntry(
    { action: 'shadowTier', label: user.throttle?.tier === 'shadow' ? 'Remove limited tier' : 'Move to limited tier' },
    moderationBlocked
  ),
  gateEntry(
    user.deletion
      ? {
          action: 'cancelDeletion',
          label: user.deletion.purgeStartedAt
            ? 'Cancel scheduled deletion (purge in progress)'
            : 'Cancel scheduled deletion',
          disabled: !!user.deletion.purgeStartedAt,
        }
      : { action: 'scheduleDeletion', label: 'Schedule deletion (user request)', danger: true },
    deletionBlocked
  ),
  gateEntry({ action: 'delete', label: 'Delete user', danger: true }, deletionBlocked),
];

const SIGNUP_METHOD_LABELS: Readonly<Record<string, string>> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  okta: 'Okta',
  email: 'email',
  password: 'email',
};

const joinedPrefix = (user: AdminUserProfile): string => {
  const method = user.acquisition?.signupMethod;
  return method ? `Joined with ${SIGNUP_METHOD_LABELS[method.toLowerCase()] ?? method} \u00b7` : 'Joined';
};

type UserProfileHeaderProps = {
  user: AdminUserProfile;
  onAction: (action: ProfileAction) => void;
  onCompliance: () => void;
};

/** Identity, status and the page's actions: Adjust credits and Suspend up front, the rest under More. */
export const UserProfileHeader: React.FC<UserProfileHeaderProps> = ({ user, onAction, onCompliance }) => {
  const name = displayName(user);
  const status = accountStatus(user);
  const org = organizationName(user);
  const level = user.level ? (LEVEL_LABELS[user.level] ?? user.level) : null;
  const { currentUser } = useUser();
  const moderationBlocked = moderationBlockedReason(currentUser, user);

  return (
    <EntityHeader
      title={name}
      id={user.id}
      email={user.email ?? undefined}
      avatar={
        <Avatar
          src={user.photoUrl || undefined}
          alt=""
          sx={{
            width: 56,
            height: 56,
            fontSize: 18,
            fontWeight: 600,
            bgcolor: 'admin.status.info.background',
            color: 'admin.status.info.foreground',
          }}
        >
          {initials(name)}
        </Avatar>
      }
      status={
        <>
          <StatusChip tone={status.tone} label={status.label} dot data-testid="user-profile-status-chip" />
          {user.throttle?.tier === 'shadow' && (
            <StatusChip
              tone="neutral"
              label={isThrottleExempt(user) ? 'Limited tier (not in effect)' : 'Limited tier'}
              data-testid="user-profile-shadow-tier-chip"
            />
          )}
          {level && <StatusChip tone="info" label={level} data-testid="user-profile-level-chip" />}
          {org && <StatusChip tone="neutral" label={org} data-testid="user-profile-org-chip" />}
        </>
      }
      times={[
        { prefix: joinedPrefix(user), at: user.createdAt, 'data-testid': 'user-profile-joined' },
        { prefix: 'Active', at: user.lastActiveAt, 'data-testid': 'user-profile-last-active' },
      ]}
      actions={
        <>
          <Button
            variant="outlined"
            color="neutral"
            onClick={() => onAction('credits')}
            data-testid="user-profile-adjust-credits-btn"
          >
            Adjust credits
          </Button>
          {!user.isBanned && (
            <AdminPermissionAction requirement="users:moderate" blockedReason={moderationBlocked}>
              {disabled => (
                <Button
                  variant="outlined"
                  color="danger"
                  disabled={disabled}
                  onClick={() => onAction('suspend')}
                  data-testid="user-profile-suspend-btn"
                >
                  Suspend
                </Button>
              )}
            </AdminPermissionAction>
          )}
          <Dropdown>
            <MenuButton
              slots={{ root: Button }}
              slotProps={{ root: { variant: 'outlined', color: 'neutral', 'aria-label': 'More actions' } }}
              sx={{ px: 1 }}
              data-testid="user-profile-more-btn"
            >
              <MoreHorizIcon />
            </MenuButton>
            <Menu placement="bottom-end" sx={{ minWidth: 240 }} data-testid="user-profile-more-menu">
              {menuEntries(
                user,
                deletionBlockedReason(currentUser, user),
                adminActionBlockedReason(currentUser, user, 'users:impersonate'),
                moderationBlocked
              ).map((entry, index) =>
                entry === 'divider' ? (
                  <ListDivider key={`divider-${index}`} />
                ) : (
                  <MenuItem
                    key={entry.action}
                    color={entry.danger ? 'danger' : 'neutral'}
                    disabled={entry.disabled}
                    onClick={() => (entry.action === 'compliance' ? onCompliance() : onAction(entry.action))}
                    data-testid={`user-profile-menu-${entry.action}-item`}
                  >
                    {entry.hint ? (
                      <Stack>
                        {entry.label}
                        <Typography level="body-xs" data-testid={`user-profile-menu-${entry.action}-hint`}>
                          {entry.hint}
                        </Typography>
                      </Stack>
                    ) : (
                      entry.label
                    )}
                  </MenuItem>
                )
              )}
            </Menu>
          </Dropdown>
        </>
      }
    />
  );
};
