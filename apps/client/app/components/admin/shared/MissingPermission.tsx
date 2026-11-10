import type { ReactElement, ReactNode } from 'react';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { Stack, Tooltip, Typography } from '@mui/joy';
import {
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionRequirement,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { adminFocusScope } from './adminStyles';

/** Every listed requirement must be met, for a route that checks more than one permission. */
export type AllOfAdminPermissions = { allOf: readonly AdminPermissionRequirement[] };
type ActionRequirement = AdminPermissionRequirement | AllOfAdminPermissions;

/**
 * The "Missing permission: X" message when the signed-in user cannot meet `requirement`, else
 * null. Mirrors the server's `adminApi` check, so a full admin always passes. For `allOf` it names
 * every unmet requirement.
 */
export function useMissingAdminPermission(requirement: ActionRequirement): string | null {
  const { currentUser } = useUser();
  return missingAdminPermissionFor(currentUser, requirement);
}

/** useMissingAdminPermission for a given user, where a hook cannot be called (inside a list). */
export function missingAdminPermissionFor(
  user: Parameters<typeof meetsAdminPermissionRequirement>[0],
  requirement: ActionRequirement
): string | null {
  const all = typeof requirement === 'object' && 'allOf' in requirement ? requirement.allOf : [requirement];
  const missing = all.filter(each => !meetsAdminPermissionRequirement(user, each));
  if (missing.length === 0) return null;
  return missing.map(each => missingAdminPermissionMessage(each)).join('; ');
}

/**
 * Stands in for a page or area the user lacks the permission to see. With no `requirement` the
 * page is open to full administrators only, so no grantable permission would unlock it.
 */
export function MissingPermissionState({ requirement }: { requirement?: AdminPermissionRequirement }) {
  return (
    <Stack
      alignItems="center"
      gap={1}
      sx={{ ...adminFocusScope, p: 3 }}
      data-testid="admin-missing-permission-state"
      role="status"
    >
      <LockOutlinedIcon sx={{ color: 'admin.inkMuted' }} />
      <Typography level="title-md" sx={{ color: 'admin.ink' }}>
        {requirement ? missingAdminPermissionMessage(requirement) : 'Full admin access required'}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        {requirement ? 'Ask a full administrator to grant it.' : 'Only full administrators can open this page.'}
      </Typography>
    </Stack>
  );
}

/** Renders `children` only for a user meeting `requirement`, else the missing-permission state. */
export function AdminPermissionGate({
  requirement,
  children,
}: {
  requirement: AdminPermissionRequirement;
  children: ReactNode;
}) {
  const missing = useMissingAdminPermission(requirement);
  return missing ? <MissingPermissionState requirement={requirement} /> : <>{children}</>;
}

/**
 * Wraps an action control: a user lacking `requirement` gets it disabled, with the
 * missing-permission message on hover and focus.
 */
export function AdminPermissionAction({
  requirement,
  children,
}: {
  requirement: ActionRequirement;
  children: (disabled: boolean) => ReactElement;
}) {
  const missing = useMissingAdminPermission(requirement);
  if (!missing) return children(false);
  return (
    <Tooltip title={missing}>
      {/* A disabled button fires no pointer events, so the tooltip needs a focusable wrapper. */}
      <span tabIndex={0} data-testid="admin-missing-permission-action">
        {children(true)}
      </span>
    </Tooltip>
  );
}
