import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  isFullAdmin,
  sortAdminRoleIds,
  type AdminPermissionId,
} from '@bike4mind/common';
import type { AdminRoleListItem } from '../useAdminRoleList';

type AdminIdentity = Parameters<typeof hasAdminPermission>[0];
type RoleRef = Pick<AdminRoleListItem, 'id' | 'name' | 'permissions'>;

/** One effective permission and every source that grants it. */
export type PermissionProvenance = { id: AdminPermissionId; direct: boolean; roleNames: string[] };

/**
 * Effective permissions (direct grants UNION role permissions, as server-utils auth/adminRoles.ts
 * resolves them), in ADMIN_PERMISSIONS order. Ids naming no known role grant nothing, as on the server.
 */
export const permissionProvenance = (
  direct: readonly string[],
  roleIds: readonly string[],
  roles: readonly RoleRef[]
): PermissionProvenance[] => {
  const held = new Set(sortAdminRoleIds(roleIds));
  const heldRoles = roles.filter(role => held.has(role.id.toLowerCase()));
  return ADMIN_PERMISSIONS.flatMap(id => {
    const roleNames = heldRoles.filter(role => role.permissions.includes(id)).map(role => role.name);
    const isDirect = direct.includes(id);
    return isDirect || roleNames.length > 0 ? [{ id, direct: isDirect, roleNames }] : [];
  });
};

/** "from Support agent", "granted directly", or both joined. */
export const describeProvenance = ({ direct, roleNames }: Pick<PermissionProvenance, 'direct' | 'roleNames'>) =>
  [roleNames.length > 0 && `from ${roleNames.join(', ')}`, direct && 'granted directly'].filter(Boolean).join('; ');

/**
 * Why the actor cannot assign this role, or null. Mirrors assertCanGrantAdminAccess: holding a role
 * grants its permissions, so a delegate may only assign roles whose permissions they hold.
 */
export const roleGrantBlockedReason = (actor: AdminIdentity, role: Pick<RoleRef, 'permissions'>): string | null => {
  if (isFullAdmin(actor)) return null;
  const unheld = role.permissions.filter(permission => !hasAdminPermission(actor, permission));
  return unheld.length > 0 ? `You do not hold ${unheld.join(', ')}` : null;
};
