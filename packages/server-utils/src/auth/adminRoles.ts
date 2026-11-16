import { AdminRoleIdSchema, sortAdminPermissions, type AdminPermissionId, type AdminRole } from '@bike4mind/common';
import { adminRoleRepository } from '@bike4mind/database';

type RoleHolder = {
  adminRoleIds?: readonly unknown[] | null;
  /** Present on a Mongoose document; the User schema's `roleAdminPermissions` virtual reads it. */
  $locals?: Record<string, unknown>;
};

export type FindAdminRoles = (ids: readonly string[]) => Promise<Pick<AdminRole, 'permissions'>[]>;

const findRoles: FindAdminRoles = ids => adminRoleRepository.findByIds(ids);

/** The user's role ids that are well-formed; anything else grants nothing. */
export function heldAdminRoleIds(user: RoleHolder): string[] {
  return (user.adminRoleIds ?? []).map(String).filter(id => AdminRoleIdSchema.safeParse(id).success);
}

/**
 * Attaches the permissions the user's admin roles carry as `roleAdminPermissions`, which
 * hasAdminPermission unions with the direct `adminPermissions`. Run once per request, after the
 * user is loaded, so role and membership changes apply on the next request. Unknown or deleted
 * role ids grant nothing. A user with no roles costs no query.
 *
 * On a document the value lives in `$locals` behind the schema virtual, so save() never persists
 * it and toJSON() carries it to the self view. When withholdAdminRole has run (an API key without
 * the admin scope), its own accessors keep both role fields reading empty either way.
 */
export async function resolveRoleAdminPermissions<T extends RoleHolder>(
  user: T,
  find: FindAdminRoles = findRoles
): Promise<T> {
  const ids = heldAdminRoleIds(user);
  const roles = ids.length > 0 ? await find(ids) : [];
  const permissions: AdminPermissionId[] = sortAdminPermissions(roles.flatMap(role => role.permissions));
  if (user.$locals && typeof user.$locals === 'object') {
    user.$locals.roleAdminPermissions = permissions;
  } else {
    Object.assign(user, { roleAdminPermissions: permissions });
  }
  return user;
}
