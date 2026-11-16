import { z } from 'zod';
import { AdminPermissionSchema, sortAdminPermissions, type AdminPermissionId } from './adminPermissions';

/**
 * Admin roles: named, admin-defined sets of the code-defined ADMIN_PERMISSIONS. Roles are database
 * rows (packages/database AdminRoleModel); a user's effective permissions are their direct
 * `adminPermissions` plus every role's, resolved per request (server-utils auth/adminRoles.ts).
 * A role never carries `isAdmin`: full admin stays its own flag.
 */

export const ADMIN_ROLE_NAME_MAX_LENGTH = 60;
export const ADMIN_ROLE_DESCRIPTION_MAX_LENGTH = 500;
/** At least one permission: an empty role would still mark its members as holding admin access. */
export const AdminRolePermissionsSchema = z
  .array(AdminPermissionSchema)
  .min(1, 'A role needs at least one permission')
  .refine(ids => new Set(ids).size === ids.length, 'Admin permissions must not repeat')
  .transform(ids => sortAdminPermissions(ids));

const AdminRoleNameSchema = z.string().trim().min(1, 'Name the role').max(ADMIN_ROLE_NAME_MAX_LENGTH);
const AdminRoleDescriptionSchema = z.string().trim().max(ADMIN_ROLE_DESCRIPTION_MAX_LENGTH);

export const AdminRoleCreateSchema = z
  .object({
    name: AdminRoleNameSchema,
    description: AdminRoleDescriptionSchema.default(''),
    permissions: AdminRolePermissionsSchema,
  })
  .strict();
export type AdminRoleCreate = z.infer<typeof AdminRoleCreateSchema>;

export const AdminRoleUpdateSchema = z
  .object({
    name: AdminRoleNameSchema.optional(),
    description: AdminRoleDescriptionSchema.optional(),
    permissions: AdminRolePermissionsSchema.optional(),
  })
  .strict()
  .refine(patch => Object.values(patch).some(value => value !== undefined), 'Nothing to change');
export type AdminRoleUpdate = z.infer<typeof AdminRoleUpdateSchema>;

export type AdminRole = {
  id: string;
  name: string;
  description: string;
  permissions: AdminPermissionId[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Attaches the user's role-derived `roleAdminPermissions` (server-utils auth/adminRoles.ts). Services
 * that re-read the acting admin take it as an adapter, so a role-held permission still counts on the
 * fresh record; without it the re-read sees direct grants only and fails closed.
 */
export type ResolveAdminRoles = <T extends object>(user: T) => Promise<T>;

export type AdminRoleTemplate = {
  /** Stable key for "new role from template"; never stored on the role. */
  id: string;
  name: string;
  description: string;
  permissions: readonly AdminPermissionId[];
};

/**
 * Starting points for a new role. Creating from a template copies these into an ordinary,
 * fully editable role, so changing a template here never changes an existing role's access.
 * `users:delete`, `users:impersonate` and `users:export` are deliberately in no template.
 */
export const ADMIN_ROLE_TEMPLATES = [
  {
    id: 'support-read-only',
    name: 'Support (read-only)',
    description: 'Look up users, accounts and admin history without changing anything.',
    permissions: ['support:read'],
  },
  {
    id: 'support-agent',
    name: 'Support agent',
    description: 'Support lookups plus moderating users: suspensions, restrictions and verification.',
    permissions: ['support:read', 'users:moderate'],
  },
  {
    id: 'billing',
    name: 'Billing',
    description: 'Support lookups plus credit adjustments and subscription changes.',
    permissions: ['support:read', 'credits:adjust'],
  },
  {
    id: 'trust-and-safety',
    name: 'Trust & Safety',
    description: 'Support lookups, user moderation and revoking API keys.',
    permissions: ['support:read', 'users:moderate', 'keys:revoke'],
  },
  {
    id: 'platform-settings',
    name: 'Platform settings',
    description: 'Manage platform settings and curate the model list.',
    permissions: ['settings:manage', 'models:curate'],
  },
] as const satisfies readonly AdminRoleTemplate[];

export type AdminRoleTemplateId = (typeof ADMIN_ROLE_TEMPLATES)[number]['id'];
