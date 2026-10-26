import { z } from 'zod';

export const ADMIN_PERMISSIONS = [
  'support:read',
  'credits:adjust',
  'users:moderate',
  'users:impersonate',
  'keys:revoke',
  'users:delete',
  'settings:manage',
] as const;

export const AdminPermissionSchema = z.enum(ADMIN_PERMISSIONS);
export const AdminPermissionsSchema = z.array(AdminPermissionSchema).max(ADMIN_PERMISSIONS.length);
export type AdminPermissionId = z.infer<typeof AdminPermissionSchema>;

type AdminIdentity = {
  isAdmin?: boolean | null;
  adminPermissions?: readonly string[] | null;
};

export function hasAdminPermission(user: AdminIdentity | null | undefined, permission: AdminPermissionId): boolean {
  return user?.isAdmin === true || user?.adminPermissions?.includes(permission) === true;
}

export function canAccessAdmin(user: AdminIdentity | null | undefined): boolean {
  return ADMIN_PERMISSIONS.some(permission => hasAdminPermission(user, permission));
}

export function isFullAdmin(user: AdminIdentity | null | undefined): boolean {
  return ADMIN_PERMISSIONS.every(permission => hasAdminPermission(user, permission));
}
