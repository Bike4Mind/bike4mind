import { Permission } from './ShareableDocumentTypes';

/**
 * The roles an organization invite may grant, as the exact permission set the accepted member's
 * `users[]` row receives. Labels match the member chips in apps/client/app/components/organizations/UserCard.tsx.
 * `admin` may only be granted by the billing owner or a platform admin (`isOrgOwnerOrPlatformAdmin`).
 */
export const ORG_INVITE_ROLES = {
  viewer: [Permission.read],
  editor: [Permission.read, Permission.update],
  admin: [Permission.read, Permission.update, Permission.share],
} as const satisfies Record<string, readonly Permission[]>;

export type OrgInviteRole = keyof typeof ORG_INVITE_ROLES;

export const ORG_INVITE_ROLE_NAMES = Object.keys(ORG_INVITE_ROLES) as OrgInviteRole[];

/** The role whose permission set equals `permissions` (order and duplicates ignored), or null. */
export const roleForPermissions = (permissions: readonly Permission[]): OrgInviteRole | null => {
  const given = new Set(permissions);
  return (
    ORG_INVITE_ROLE_NAMES.find(role => {
      const expected: readonly Permission[] = ORG_INVITE_ROLES[role];
      return expected.length === given.size && expected.every(permission => given.has(permission));
    }) ?? null
  );
};

/** Most addresses one organization bulk invite takes; the client modal and the route both enforce it. */
export const MAX_ORG_BULK_INVITE_ROWS = 100;
