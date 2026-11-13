/**
 * Organization ("Team") roles and the permissions each one grants - the single answer to "may this
 * person administer this part of the team?". Server gates (`verifyOrgPermission`,
 * packages/server-utils/src/utils/orgAccess.ts), the organization services and the client's tab and
 * control gates (apps/client/app/routes/organizations/orgTabAccess.ts) all ask `hasOrgPermission`;
 * the lists are read directly only by verifyOrgAdminRead (orgAccess.ts), canRevokeOrgMember
 * (organization.ts) and the CASL manager rule (packages/server-utils/src/auth/ability.ts).
 *
 * Storage, one list per assignable role:
 * - Owner: `org.userId`, the billing owner. Changed only by the ownership transfer.
 * - Manager: `adminUserIds`.
 * - Billing manager: `billingManagerUserIds`.
 * - Member: anyone else with a `users[]` row.
 * A role-list entry counts only while the user still holds a `users[]` row, so a removal that misses
 * a list leaves no authority behind. Resolution takes the first match in the order above, so a user
 * on both lists reads as Manager.
 */

/** Every org-administration capability. Add one only together with the routes it gates. */
export const ORG_PERMISSIONS = [
  /** Invite, add and remove members, manage groups, and see the roster's activity. */
  'manageMembers',
  /** Subscribe, change seats, open the billing portal, attach the Stripe customer. */
  'manageBilling',
  /** The team's credit spend, ledger and per-session usage. */
  'viewUsage',
  /** Team-wide policy: the custom MCP connector policy, member credit budgets and team branding. */
  'managePolicies',
  /** Team-wide integration wiring and its secrets: Slack, the team GitHub connection, webhooks. */
  'manageIntegrations',
  /** Team API keys, including revoking the team-billed keys members hold. */
  'manageKeys',
  /** Team-scoped content: data lake sources, team skills, work items, storage and feedback analysis. */
  'manageContent',
  /** The team's audit trail and its CSV export. */
  'viewAudit',
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const ORG_ROLES = ['owner', 'manager', 'billingManager', 'member'] as const;

export type OrganizationMemberRole = (typeof ORG_ROLES)[number];

/** The roles an owner or manager can hand out; Owner moves only through the ownership transfer. */
export const ASSIGNABLE_ORG_ROLES = [
  'manager',
  'billingManager',
  'member',
] as const satisfies readonly OrganizationMemberRole[];

export type AssignableOrgRole = (typeof ASSIGNABLE_ORG_ROLES)[number];

/**
 * The built-in role table. Manager and Owner reproduce the two tiers the gates enforced before roles
 * existed (owner-or-manager vs owner-only), so introducing the table changed nobody's access. Usage
 * and ledger reads (`viewUsage`) are open to managers too; spending (`manageBilling`) is not.
 */
export const ORG_ROLE_PERMISSIONS: Readonly<Record<OrganizationMemberRole, readonly OrgPermission[]>> = {
  owner: ORG_PERMISSIONS,
  manager: ['manageMembers', 'viewUsage', 'managePolicies', 'manageKeys', 'manageContent', 'viewAudit'],
  billingManager: ['manageBilling', 'viewUsage'],
  member: [],
};

/** The organization slice a role decision needs. */
export type OrgRoleSubject = {
  userId: string;
  adminUserIds?: readonly string[] | null;
  billingManagerUserIds?: readonly string[] | null;
  users?: ReadonlyArray<{ userId: string }> | null;
};

/** The actor slice a permission decision needs - resolved from auth, never from a request body. */
export type OrgPermissionActor = { id: string; isAdmin?: boolean | null };

/** The user's role in the org, or null when they are neither its owner nor on its roster. */
export const organizationMemberRole = (org: OrgRoleSubject, userId: string): OrganizationMemberRole | null => {
  if (org.userId === userId) return 'owner';
  if (!(org.users ?? []).some(member => member.userId === userId)) return null;
  if ((org.adminUserIds ?? []).includes(userId)) return 'manager';
  if ((org.billingManagerUserIds ?? []).includes(userId)) return 'billingManager';
  return 'member';
};

export const orgRoleHasPermission = (role: OrganizationMemberRole, permission: OrgPermission): boolean =>
  ORG_ROLE_PERMISSIONS[role].includes(permission);

/**
 * Does `userId`'s own role grant `permission`? No platform-admin arm: use this only where a platform
 * admin must not act as the team (the Stripe billing portal, the Billing tab).
 */
export const orgMemberHasPermission = (org: OrgRoleSubject, userId: string, permission: OrgPermission): boolean => {
  const role = organizationMemberRole(org, userId);
  return role !== null && orgRoleHasPermission(role, permission);
};

/** May this actor exercise `permission` on the org? A platform admin holds every permission. */
export const hasOrgPermission = (actor: OrgPermissionActor, org: OrgRoleSubject, permission: OrgPermission): boolean =>
  actor.isAdmin === true || orgMemberHasPermission(org, actor.id, permission);
