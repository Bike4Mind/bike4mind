import {
  DEVELOPER_USER_TAGS,
  hasDeveloperUserTag,
  type ILoginRecord,
  type IUserDocument,
  type OrganizationMemberRole,
} from '@bike4mind/common';
export { isManagedTag } from '@client/lib/entitlements/managedUserTags';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';

/**
 * A user as the profile page has it: GET /api/users/[id] returns the whole document, so fields the
 * list projection leaves out (signup channel, internal notes) are there too. List rows lack them.
 */
export type AdminUserProfile = AdminUserListItem &
  Partial<Pick<IUserDocument, 'acquisition' | 'userNotes' | 'emailVerifiedAt'>>;

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

/** The most recent sign-in; records are appended, but sort anyway since nothing guarantees it. */
export const latestSignIn = (user: Pick<AdminUserListItem, 'loginRecords'>): ILoginRecord | null =>
  [...(user.loginRecords ?? [])].sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime())[0] ??
  null;
