import { z } from 'zod';
import { ForbiddenError } from './errors';

export const ADMIN_PERMISSIONS = [
  'support:read',
  'credits:adjust',
  'users:moderate',
  'users:impersonate',
  'keys:revoke',
  'users:delete',
  'users:export',
  'settings:manage',
  'models:curate',
] as const;

export const AdminPermissionSchema = z.enum(ADMIN_PERMISSIONS);
export const AdminPermissionsSchema = z
  .array(AdminPermissionSchema)
  .max(ADMIN_PERMISSIONS.length)
  .refine(ids => new Set(ids).size === ids.length, 'Admin permissions must not repeat');
export type AdminPermissionId = z.infer<typeof AdminPermissionSchema>;

/** Bounds how many admin roles (adminRoles.ts) one user can hold, so per-request resolution stays one small query. */
export const MAX_ADMIN_ROLES_PER_USER = 20;
export const AdminRoleIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, 'Expected an id');
export const AdminRoleIdsSchema = z
  .array(AdminRoleIdSchema)
  .max(MAX_ADMIN_ROLES_PER_USER)
  .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'Admin roles must not repeat');
/** Lowercased, de-duplicated and sorted, so stored arrays and audit diffs are stable. */
export const sortAdminRoleIds = (ids: readonly string[]): string[] =>
  [...new Set(ids.map(id => id.toLowerCase()))].sort();

/**
 * `before` is the set the editor loaded, so a concurrent change is a conflict rather than a silent
 * overwrite. Role membership is optional and travels as a pair the same way: `beforeAdminRoleIds`
 * with `adminRoleIds`, or neither to leave roles untouched.
 */
export const AdminUserPermissionsChangeSchema = z
  .object({
    before: AdminPermissionsSchema,
    adminPermissions: AdminPermissionsSchema,
    beforeAdminRoleIds: AdminRoleIdsSchema.optional(),
    adminRoleIds: AdminRoleIdsSchema.optional(),
    reason: z.string(),
  })
  .strict()
  .refine(
    change => (change.beforeAdminRoleIds === undefined) === (change.adminRoleIds === undefined),
    'Send beforeAdminRoleIds and adminRoleIds together'
  );
export type AdminUserPermissionsChange = z.infer<typeof AdminUserPermissionsChangeSchema>;

/**
 * Orders a permission set the way ADMIN_PERMISSIONS lists them, so stored arrays and audit diffs are
 * stable. Drops repeats and ids no longer in the list.
 */
export const sortAdminPermissions = (ids: readonly string[]): AdminPermissionId[] =>
  ADMIN_PERMISSIONS.filter(id => ids.includes(id));
/** One permission, or a list any one of which suffices. */
export type AdminPermissionRequirement = AdminPermissionId | readonly AdminPermissionId[];

/**
 * The reads of a page whose writes need `settings:manage`: a settings manager can open the page
 * it edits without also holding `support:read`. Shared by those routes' GET declarations and their
 * admin console tabs (`adminTabPermissions.ts`), so the two stay in step.
 */
export const SETTINGS_PAGE_READ = ['support:read', 'settings:manage'] as const satisfies readonly AdminPermissionId[];

/** The reads of a page whose writes need `users:moderate`; the SETTINGS_PAGE_READ counterpart for moderation. */
export const MODERATION_PAGE_READ = ['support:read', 'users:moderate'] as const satisfies readonly AdminPermissionId[];

/** The same for credits: the credit, grant and subscription reads a `credits:adjust` delegate needs beside its writes. */
export const CREDITS_PAGE_READ = ['support:read', 'credits:adjust'] as const satisfies readonly AdminPermissionId[];

/**
 * Settings that constrain delegated admins themselves, so `settings:manage` alone must not loosen them:
 * only a full admin may change them. Enforced by `pages/api/settings/update.ts`; the admin settings page
 * locks the same fields for delegates.
 */
export const FULL_ADMIN_SETTING_KEYS: ReadonlySet<string> = new Set([
  'AdminApprovalsEnabled',
  'AdminApprovalBulkUserThreshold',
  'AdminApprovalCreditThreshold',
  'AdminApprovalExpiryHours',
  'AdminAuditCriticalGrantCredits',
  'AdminAuditDailyGrantCredits',
  'SlackSecurityAlertsWebhookUrl',
  'enforceMFA',
  'allowTrustedDevices',
  // Sets how large a signup grant may be while the signup assessment policy is off (checkSignupGrantSave).
  'signupGrantUnprotectedMaxCredits',
]);

type AdminIdentity = {
  isAdmin?: boolean | null;
  /** Direct grants, stored on the user. */
  adminPermissions?: readonly string[] | null;
  /** Permissions from the user's admin roles, resolved per request and never stored (adminRoles.ts). */
  roleAdminPermissions?: readonly string[] | null;
  /** Role membership. Counts as admin access for target protection even before roles are resolved. */
  adminRoleIds?: readonly unknown[] | null;
};

/** Effective = direct grants UNION role permissions; a user whose roles were not resolved has only the former. */
export function hasAdminPermission(user: AdminIdentity | null | undefined, permission: AdminPermissionId): boolean {
  return (
    user?.isAdmin === true ||
    user?.adminPermissions?.includes(permission) === true ||
    user?.roleAdminPermissions?.includes(permission) === true
  );
}

export function meetsAdminPermissionRequirement(
  user: AdminIdentity | null | undefined,
  requirement: AdminPermissionRequirement
): boolean {
  const anyOf: readonly AdminPermissionId[] = typeof requirement === 'string' ? [requirement] : requirement;
  return anyOf.some(permission => hasAdminPermission(user, permission));
}

/**
 * Whether the user holds any admin access. Role membership alone counts, so a target loaded
 * without resolving its roles is still protected by assertCanActOnAdminTarget.
 */
export function canAccessAdmin(user: AdminIdentity | null | undefined): boolean {
  return (
    ADMIN_PERMISSIONS.some(permission => hasAdminPermission(user, permission)) || (user?.adminRoleIds?.length ?? 0) > 0
  );
}

/** Full admin is exactly the legacy `isAdmin` flag; holding every explicit permission is still delegated access. */
export function isFullAdmin(user: AdminIdentity | null | undefined): boolean {
  return user?.isAdmin === true;
}

export function missingAdminPermissionMessage(requirement: AdminPermissionRequirement): string {
  return `Missing permission: ${typeof requirement === 'string' ? requirement : requirement.join(' or ')}`;
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
