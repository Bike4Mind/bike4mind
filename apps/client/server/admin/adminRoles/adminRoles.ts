import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  isFullAdmin,
  sortAdminPermissions,
  type AdminPermissionId,
  type AdminRole,
  type AdminRoleCreate,
  type AdminRoleUpdate,
} from '@bike4mind/common';
import type { IAdminRoleRepository } from '@bike4mind/database';
import type { AdminAuditWriter } from '@bike4mind/server-utils/utils/adminAudit';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';

/**
 * Admin role CRUD (pages/api/admin/admin-roles). Reads are open to support:read; every write is
 * full-admin only, because editing a role's permissions is a grant to every member and only a full
 * admin may grant without limit. Membership is assigned through the user permissions endpoint
 * (pages/api/admin/users/[userId]/permissions.ts).
 */

export type AdminRoleWithMembers = AdminRole & { memberCount: number };

export type AdminRolesDeps = {
  roles: IAdminRoleRepository;
  /** Users holding each role; a role nobody holds may be missing from the map. */
  memberCounts: (roleIds: readonly string[]) => Promise<Map<string, number>>;
  /** Drops the role from any user still holding it (an assignment that raced the delete); returns how many. */
  removeFromMembers: (roleId: string) => Promise<number>;
  audit: AdminAuditWriter;
  /** Recent re-verification, as the user grant endpoint asks before handing out a permission. */
  requireStepUp: () => Promise<void>;
  /** The audit entries are strict, so each write commits together with its record or not at all. */
  transaction: <T>(work: () => Promise<T>) => Promise<T>;
};

type Actor = { id: string; isAdmin?: boolean | null };

const assertCanEditRoles = (actor: Actor) => {
  if (!isFullAdmin(actor)) throw new ForbiddenError('Only full administrators can change admin roles');
};

const NAME_TAKEN = 'An admin role with this name already exists.';
const notFound = () => new NotFoundError('Admin role not found');

const roleTarget = (role: Pick<AdminRole, 'id' | 'name'>) => ({
  kind: 'adminRole' as const,
  id: role.id,
  displayName: role.name,
});

const diff = (before: readonly AdminPermissionId[], after: readonly AdminPermissionId[]) => ({
  granted: after.filter(id => !before.includes(id)),
  revoked: before.filter(id => !after.includes(id)),
});

const memberCountOf = async (deps: AdminRolesDeps, roleId: string) =>
  (await deps.memberCounts([roleId])).get(roleId.toLowerCase()) ?? 0;

export async function listAdminRoles(deps: AdminRolesDeps): Promise<AdminRoleWithMembers[]> {
  const roles = await deps.roles.list();
  const counts = await deps.memberCounts(roles.map(role => role.id));
  return roles.map(role => ({ ...role, memberCount: counts.get(role.id) ?? 0 }));
}

export async function getAdminRole(roleId: string, deps: AdminRolesDeps): Promise<AdminRoleWithMembers> {
  const role = await deps.roles.findById(roleId);
  if (!role) throw notFound();
  return { ...role, memberCount: await memberCountOf(deps, roleId) };
}

export async function createAdminRole(
  actor: Actor,
  input: AdminRoleCreate,
  deps: AdminRolesDeps
): Promise<AdminRoleWithMembers> {
  assertCanEditRoles(actor);
  return deps.transaction(async () => {
    let role: AdminRole;
    try {
      role = await deps.roles.create({ ...input, createdBy: actor.id });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictError(NAME_TAKEN);
      throw error;
    }
    await deps.audit({
      action: 'admin.role.created',
      target: roleTarget(role),
      summary: `created with ${role.permissions.join(', ')}`,
      changes: [{ field: 'permissions', before: [], after: role.permissions }],
      details: { permissions: role.permissions, memberCount: 0 },
    });
    return { ...role, memberCount: 0 };
  });
}

export async function updateAdminRole(
  actor: Actor,
  roleId: string,
  patch: AdminRoleUpdate,
  deps: AdminRolesDeps
): Promise<AdminRoleWithMembers> {
  assertCanEditRoles(actor);
  const before = await deps.roles.findById(roleId);
  if (!before) throw notFound();
  // Adding a permission grants it to every member at once, so it needs the same proof a direct grant does.
  const requested = patch.permissions ? sortAdminPermissions(patch.permissions) : before.permissions;
  if (diff(before.permissions, requested).granted.length > 0) await deps.requireStepUp();
  return deps.transaction(async () => {
    let after: AdminRole | null;
    try {
      after = await deps.roles.update(roleId, patch);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictError(NAME_TAKEN);
      throw error;
    }
    if (!after) throw notFound();

    const memberCount = await memberCountOf(deps, roleId);
    const { granted, revoked } = diff(before.permissions, after.permissions);
    const changes = [
      ...(before.name !== after.name ? [{ field: 'name', before: before.name, after: after.name }] : []),
      ...(before.description !== after.description
        ? [{ field: 'description', before: before.description, after: after.description }]
        : []),
      ...(granted.length || revoked.length
        ? [{ field: 'permissions', before: before.permissions, after: after.permissions }]
        : []),
    ];
    if (changes.length > 0) {
      const permissionSummary = [
        granted.length && `granted ${granted.join(', ')}`,
        revoked.length && `revoked ${revoked.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ');
      await deps.audit({
        action: 'admin.role.updated',
        target: roleTarget(after),
        summary: permissionSummary
          ? `${permissionSummary} for ${memberCount} member${memberCount === 1 ? '' : 's'}`
          : `edited ${changes.map(change => change.field).join(', ')}`,
        changes,
        details: { granted, revoked, memberCount },
      });
    }
    return { ...after, memberCount };
  });
}

/** Refused while the role has members, so deleting a role never silently strips anyone's access. */
export async function deleteAdminRole(actor: Actor, roleId: string, deps: AdminRolesDeps): Promise<void> {
  assertCanEditRoles(actor);
  await deps.transaction(async () => {
    const role = await deps.roles.findById(roleId);
    if (!role) throw notFound();
    const memberCount = await memberCountOf(deps, roleId);
    if (memberCount > 0) {
      throw new ConflictError(
        `Remove this role from its ${memberCount} member${memberCount === 1 ? '' : 's'} before deleting it.`,
        { member_count: memberCount }
      );
    }
    if (!(await deps.roles.delete(roleId))) throw notFound();
    const removedFromMembers = await deps.removeFromMembers(roleId);
    await deps.audit({
      action: 'admin.role.deleted',
      target: roleTarget(role),
      summary: `deleted (held ${role.permissions.join(', ')})`,
      changes: [{ field: 'permissions', before: role.permissions, after: [] }],
      details: { permissions: role.permissions, memberCount: 0, removedFromMembers },
    });
  });
}
