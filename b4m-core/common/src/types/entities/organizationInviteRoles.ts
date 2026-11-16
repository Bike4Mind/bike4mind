import { Permission } from './ShareableDocumentTypes';

/**
 * The roles an organization invite may grant, as the exact permission set the accepted member's
 * `users[]` row receives. These grant labels are separate from team ownership and manager status.
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

/** Limits shared by organization link forms and server validation. */
export const MAX_ORG_LINK_AVAILABLE = 1000;
export const MAX_INVITE_ALLOWED_DOMAINS = 10;
export const INVITE_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
