import { ADMIN_PERMISSIONS, sortAdminPermissions, type AdminPermissionId } from '@bike4mind/common';
import { ADMIN_PERMISSION_LABELS } from '../Users/Profile/userProfileModel';

/** Permissions that hand out data or identity power, so adding one to a role asks for a second confirmation. */
export const SENSITIVE_ROLE_PERMISSIONS = [
  'users:delete',
  'users:impersonate',
  'users:export',
] as const satisfies readonly AdminPermissionId[];

export const isSensitivePermission = (id: AdminPermissionId): boolean =>
  (SENSITIVE_ROLE_PERMISSIONS as readonly AdminPermissionId[]).includes(id);

export const permissionLabel = (id: AdminPermissionId): string => ADMIN_PERMISSION_LABELS[id].label;

export const permissionDescription = (id: AdminPermissionId): string => ADMIN_PERMISSION_LABELS[id].description;

export const permissionLabels = (ids: readonly AdminPermissionId[]): string =>
  ids.length ? sortAdminPermissions(ids).map(permissionLabel).join(', ') : 'none';

export function diffPermissions(before: readonly AdminPermissionId[], after: readonly AdminPermissionId[]) {
  return {
    granted: ADMIN_PERMISSIONS.filter(id => after.includes(id) && !before.includes(id)),
    revoked: ADMIN_PERMISSIONS.filter(id => before.includes(id) && !after.includes(id)),
  };
}

export const pluralUsers = (count: number): string => `${count.toLocaleString()} ${count === 1 ? 'user' : 'users'}`;
