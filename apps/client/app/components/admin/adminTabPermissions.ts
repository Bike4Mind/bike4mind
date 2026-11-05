import { hasAdminPermission, isFullAdmin, type AdminPermissionId } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';

type AdminIdentity = Parameters<typeof hasAdminPermission>[0];

/**
 * The tabs a delegated admin (`adminPermissions` without `isAdmin`) may open, and the permission
 * each one needs. Fail closed: list a tab only once every request it makes accepts that
 * permission server-side. An unlisted tab stays full-admin only, so a delegate never lands on a
 * pane its own requests answer with 403.
 */
export const DELEGATED_ADMIN_TAB_PERMISSIONS: Readonly<Partial<Record<AdminTab, AdminPermissionId>>> = {
  // The modal endpoints' CASL rules grant read and write on settings:manage. What's new shares
  // them but stays out: its highlights panel and LiveOps lookup are full-admin only.
  [AdminTab.Modals]: 'settings:manage',
};

export function canOpenAdminTab(user: AdminIdentity, tab: AdminTab): boolean {
  if (isFullAdmin(user)) return true;
  const permission = DELEGATED_ADMIN_TAB_PERMISSIONS[tab];
  return permission !== undefined && hasAdminPermission(user, permission);
}

/**
 * Whether the admin console has anything to show this user. A delegate whose permissions open no
 * tab is turned away rather than shown an empty console.
 */
export function canEnterAdminConsole(user: AdminIdentity): boolean {
  if (isFullAdmin(user)) return true;
  return Object.values(DELEGATED_ADMIN_TAB_PERMISSIONS).some(
    permission => permission !== undefined && hasAdminPermission(user, permission)
  );
}
