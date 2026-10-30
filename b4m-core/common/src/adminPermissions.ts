import { z } from 'zod';
import { ForbiddenError } from './errors';

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
export const AdminPermissionsSchema = z
  .array(AdminPermissionSchema)
  .max(ADMIN_PERMISSIONS.length)
  .refine(ids => new Set(ids).size === ids.length, 'Admin permissions must not repeat');
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

/** Full admin is exactly the legacy `isAdmin` flag; holding every explicit permission is still delegated access. */
export function isFullAdmin(user: AdminIdentity | null | undefined): boolean {
  return user?.isAdmin === true;
}

export function missingAdminPermissionMessage(permission: AdminPermissionId): string {
  return `Missing permission: ${permission}`;
}

/**
 * Delegated admins must not act on accounts that themselves hold admin access, or they could
 * escalate through the target. `action` completes "Only full administrators can <action> users with admin access".
 */
export function assertCanActOnAdminTarget(
  actor: AdminIdentity | null | undefined,
  target: AdminIdentity | null | undefined,
  action: string
): void {
  if (canAccessAdmin(target) && !isFullAdmin(actor)) {
    throw new ForbiddenError(`Only full administrators can ${action} users with admin access`);
  }
}

/**
 * A delegated settings manager may only hand out grants it holds, and never the full-admin flag.
 * This checks the grant only, not who receives it: a grant endpoint must also call
 * assertCanActOnAdminTarget so a delegate cannot demote or strip an account with admin access.
 */
export function assertCanGrantAdminAccess(
  actor: AdminIdentity | null | undefined,
  grant: { isAdmin?: boolean; adminPermissions?: readonly AdminPermissionId[] }
): void {
  if (isFullAdmin(actor)) return;
  if (grant.isAdmin === true) throw new ForbiddenError('Only full administrators can grant full admin access');
  const unheld = (grant.adminPermissions ?? []).filter(permission => !hasAdminPermission(actor, permission));
  if (unheld.length > 0) {
    throw new ForbiddenError(`Cannot grant permissions you do not hold: ${unheld.join(', ')}`, {
      unheld_permissions: unheld,
    });
  }
}
