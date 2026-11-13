import {
  CLIENT_SURFACES,
  DEVELOPER_USER_TAGS,
  canAccessAdmin,
  hasAdminPermission,
  hasDeveloperUserTag,
  isFullAdmin,
  missingAdminPermissionMessage,
  type AdminPermissionId,
  type AccountDeletionSource,
  type ClientSurface,
  type UserSignIn,
  type UserSignInsPage,
  type IUserDocument,
  type OrganizationMemberRole,
} from '@bike4mind/common';
export { isManagedTag } from '@client/lib/entitlements/managedUserTags';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type { AdminUserListItem } from '@bike4mind/server-utils/app/utils/adminUserProjection';

type AdminIdentity = Parameters<typeof hasAdminPermission>[0];

/**
 * Why an admin action on this profile is unavailable, or null. Mirrors the server gate: the permission,
 * and full admin for a target with admin access.
 */
export const adminActionBlockedReason = (
  actor: AdminIdentity,
  target: AdminIdentity,
  permission: AdminPermissionId
): string | null => {
  if (!hasAdminPermission(actor, permission)) return missingAdminPermissionMessage(permission);
  if (canAccessAdmin(target) && !isFullAdmin(actor))
    return 'Only full administrators can act on accounts with admin access';
  return null;
};

/**
 * A user as the profile page has it: GET /api/users/[id] returns the whole document, so fields the
 * list projection leaves out (signup channel, internal notes) are there too. List rows lack them.
 */
export type AdminUserProfile = AdminUserListItem &
  Partial<Pick<IUserDocument, 'acquisition' | 'userNotes' | 'emailVerifiedAt' | 'deletion'>>;

export const DELETION_SOURCE_LABELS: Readonly<Record<AccountDeletionSource, string>> = {
  self: 'Self-serve',
  support: 'Support',
  admin: 'Admin',
};

/** A calendar day in UTC, matching the (UTC) dates the user is emailed. */
export const formatDeletionDay = (value: Date | string): string =>
  `${new Date(value).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })} (UTC)`;

export type AccountStatus = { label: 'Active' | 'Suspended' | 'Restricted'; tone: AdminStatusTone };

/** Shared terms from DESIGN_GUIDE.md section 2: Suspended (not "banned"), Restricted (not "moderated"). */
export const accountStatus = (user: Pick<AdminUserListItem, 'isBanned' | 'isModerated'>): AccountStatus => {
  if (user.isBanned) return { label: 'Suspended', tone: 'bad' };
  if (user.isModerated) return { label: 'Restricted', tone: 'warn' };
  return { label: 'Active', tone: 'good' };
};

export type UserRole = 'customer' | 'developer' | 'super-admin';

export const USER_ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  customer: 'Customer',
  developer: 'Developer',
  'super-admin': 'Super Admin',
};

/** The auth role, derived from `isAdmin` plus the developer tag (never from `level`). */
export const userRole = (user: Pick<AdminUserListItem, 'isAdmin' | 'tags'>): UserRole => {
  if (user.isAdmin) return 'super-admin';
  if (hasDeveloperUserTag(user.tags ?? [])) return 'developer';
  return 'customer';
};

const isDeveloperTag = (tag: string): boolean => (DEVELOPER_USER_TAGS as readonly string[]).includes(tag);

/** The tags after moving to `role`: developer tags are stripped, then one `Developer` added back if needed. */
export const tagsForRole = (tags: readonly string[], role: UserRole): string[] => {
  const stripped = tags.filter(tag => !isDeveloperTag(tag));
  return role === 'developer' ? [...stripped, 'Developer'] : stripped;
};

export const displayName = (user: Pick<AdminUserListItem, 'name' | 'username' | 'email'>): string =>
  user.name?.trim() || user.username || user.email || 'Unnamed user';

/** Up to two initials for the avatar fallback. */
export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`;
  return letters.toUpperCase();
};

export const organizationName = (user: Pick<AdminUserListItem, 'organizationId'>): string | null =>
  user.organizationId && typeof user.organizationId === 'object' ? (user.organizationId.name ?? null) : null;

/** The id of the org the user is currently acting in; membership itself lives on the org documents. */
export const activeOrganizationId = (user: Pick<AdminUserListItem, 'organizationId'>): string | null => {
  const org: unknown = user.organizationId;
  if (typeof org === 'string') return org;
  return org && typeof org === 'object' && 'id' in org && typeof org.id === 'string' ? org.id : null;
};

export const ORGANIZATION_ROLE_LABELS: Readonly<Record<OrganizationMemberRole, string>> = {
  owner: 'Owner',
  manager: 'Manager',
  member: 'Member',
};

export const LEVEL_LABELS: Readonly<Record<string, string>> = {
  DemoUser: 'Demo',
  PaidUser: 'Paid',
  VIPUser: 'VIP',
  ManagerUser: 'Manager',
  AdminUser: 'Admin',
};

/** The newest successful sign-in among the loaded sign-in pages (each newest first), or null. */
export const latestSignIn = (pages: readonly UserSignInsPage[]): UserSignIn | null =>
  pages.flatMap(page => page.entries).find(entry => entry.event === 'login_success') ?? null;

export const CLIENT_SURFACE_LABELS: Readonly<Record<ClientSurface, string>> = {
  web: 'Web',
  desktop: 'Desktop',
  cli: 'CLI',
  api: 'API',
};

/** Just the client names, for a narrow column, e.g. "Web \u00b7 Desktop"; null when none are recorded. */
export const clientSurfacesSummary = (user: Pick<AdminUserProfile, 'clientUsage'>): string | null => {
  const names = CLIENT_SURFACES.filter(surface => user.clientUsage?.[surface]).map(
    surface => CLIENT_SURFACE_LABELS[surface]
  );
  return names.length > 0 ? names.join(' \u00b7 ') : null;
};

export const ADMIN_PERMISSION_LABELS: Record<AdminPermissionId, { label: string; description: string }> = {
  'support:read': { label: 'Support read', description: 'View users, organizations, logs and settings.' },
  'credits:adjust': { label: 'Adjust credits', description: 'Grant or deduct credits.' },
  'users:moderate': { label: 'Moderate users', description: 'Suspend, restrict and reinstate accounts.' },
  'users:impersonate': { label: 'Impersonate', description: 'Sign in as another user.' },
  'keys:revoke': { label: 'Revoke keys', description: 'Revoke API and embed keys.' },
  'users:delete': { label: 'Delete users', description: 'Schedule and run account deletion.' },
  'settings:manage': { label: 'Manage settings', description: 'Change admin settings, tags and product access.' },
  'models:curate': { label: 'Curate models', description: 'Change which models are offered.' },
};
