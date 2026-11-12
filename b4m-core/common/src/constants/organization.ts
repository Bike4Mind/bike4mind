import { hasOrgPermission, orgMemberHasPermission, type OrgPermissionActor, type OrgRoleSubject } from './orgRoles';

/**
 * Organization seat-limit policy - the floor and ceiling every seat change is bound by.
 *
 * These are the DEFAULTS of the admin settings `teamPlanMinSeats` / `teamPlanMaxSeats` /
 * `teamPlanCreditsPerSeat` (Admin -> Growth & Pricing). Enforcement sites read the settings via
 * `resolveTeamPlanSettings` (common/utils/teamPlanSettings) and fall back to these.
 *
 * Lives in common (not the app's subscriptions constants) because the ceiling has to be
 * enforced in the persistence layer too: `OrganizationModel.addMemberRaisingSeats` clamps
 * the auto-raise against MAX, and packages/database cannot import from apps/client. The app
 * re-exports these from `lib/subscriptions/constants` so existing importers stay unchanged.
 */

/** Paid-plan minimum seats (Stripe path). Admin grants may go smaller (see ADMIN_MIN_SEATS). */
export const ORGANIZATION_SUBSCRIPTION_MIN_SEATS = 4;

/**
 * Hard, owner-inclusive ceiling on org seats (owner + members + pending, #1423). Both
 * `validateSeatChange` and the unattended partner-rule auto-raise (`addMemberRaisingSeats`) clamp to
 * this, so a full org falls through to the at-capacity path instead of growing a seat floor that no
 * `setSeats` value can satisfy (#1424).
 */
export const ORGANIZATION_SUBSCRIPTION_MAX_SEATS = 100;

/** Credits granted per paid team seat each billing cycle. */
export const ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT = 50000;

/**
 * Absolute rail on the admin-tunable seat settings (`teamPlanMinSeats` / `teamPlanMaxSeats`): an
 * operator can move the floor and ceiling, but not past this. The constants above are the
 * settings' defaults and the fallback wherever no setting can be read.
 */
export const TEAM_PLAN_SEATS_HARD_LIMIT = 10_000;

/**
 * The org `users[]` ACL permission values that CONSTITUTE membership - the single definition every
 * "is X a member of this org" answer derives from.
 *
 * Lives in common because the same set has to be applied in three layers that cannot import each
 * other: the persistence gate (`OrganizationModel`'s `findMembershipOrgIds` / `search`, which is
 * what actually admits a reader), the engine's derived counts (`assembleLakeAccessView`'s org-channel
 * `holderCount`), and anything app-side that has to agree with both. A hand-kept second copy is how a
 * compliance surface ends up reporting a member total larger than the set the gate admits.
 *
 * 'write' implies membership even where 'read' was never explicitly granted: every app write path
 * persists ['read'], so a write-only row can only come from legacy/out-of-band data, and the gate has
 * always treated it as a member. 'write' is deliberately NOT a `Permission` enum member - adding it
 * would widen the share/invite contracts and break the exhaustive `Record<Permission, string>` maps
 * in the client.
 */
export const ORG_MEMBERSHIP_ACL_PERMISSIONS = ['read', 'write'] as const;

/**
 * Does this `users[]` ACL row confer membership? The in-memory twin of `orgMembershipFilter`'s
 * `$elemMatch` (`OrganizationModel`), for the app-side layers the docstring above anticipates -
 * anywhere that has to answer "is X a member" without issuing the Mongo query. Keep the two in
 * lockstep: they are one rule, and #2005 is what a divergence costs.
 *
 * Deliberately loose about its input rather than taking `IUserShare`: `permissions` is required by
 * the TYPE but absent on real stored rows (the appointment route could persist an admin whose row
 * had none), and the set includes 'write', which is not a `Permission` enum member. A predicate
 * that only accepted well-typed rows could not be asked about the rows that actually break.
 */
export const orgAclRowConfersMembership = (row: { permissions?: readonly string[] | null }): boolean =>
  (row.permissions ?? []).some(permission =>
    (ORG_MEMBERSHIP_ACL_PERMISSIONS as readonly string[]).includes(permission)
  );

/**
 * Is `user` a member of `org`? Combines the three membership tiers into one predicate:
 * platform admin, billing owner (org.userId), or a users[] row that passes
 * orgAclRowConfersMembership. Use this everywhere an "is X in this org?" question is
 * answered in memory; do not hand-copy the three-part expression -- that duplication is
 * how a later fix to one site fails to reach the others.
 */
export const isOrgMember = (
  user: { id: string; isAdmin?: boolean | null },
  org: { userId: string; users?: ReadonlyArray<{ userId: string; permissions?: readonly string[] | null }> | null }
): boolean =>
  user.isAdmin === true ||
  org.userId === user.id ||
  (org.users ?? []).some(member => member.userId === user.id && orgAclRowConfersMembership(member));

/**
 * The manager tier: billing owner, a current Manager, or a platform admin - exactly
 * `hasOrgPermission(user, org, 'manageMembers')`.
 *
 * @deprecated Name the permission instead (`hasOrgPermission`, constants/orgRoles.ts). Kept for the
 * readers that ask "is this person a team administrator" outside any one gate.
 */
export const isOrgOwnerOrCurrentAdmin = (user: OrgPermissionActor, org: OrgRoleSubject): boolean =>
  hasOrgPermission(user, org, 'manageMembers');

/**
 * May this actor set the org's per-member credit budgets - the default `maxCreditsPerMember` and
 * each member's `userDetails[].maxCredits` override? `managePolicies`. Appointed managers hold only a
 * read row in `users[]` and so cannot pass `shareable.findUpdateAccessById` - server callers must
 * fetch with `findById`. The budget routes enforce it; the client uses it only to decide which
 * controls to show.
 */
export const canManageMemberCreditBudgets = (user: OrgPermissionActor, org: OrgRoleSubject): boolean =>
  hasOrgPermission(user, org, 'managePolicies');

/**
 * May this actor see other members' credit fields (ORGANIZATION_MEMBER_CREDIT_FIELDS)? Whoever sets
 * the budgets (`managePolicies`) or reads the team's usage (`viewUsage`). The REST serializer
 * (`toSafeOrganization`) and the realtime field limits (`dataSubscribeRequest`) both ask this.
 */
export const canViewOrgMemberCredits = (user: OrgPermissionActor, org: OrgRoleSubject): boolean =>
  hasOrgPermission(user, org, 'managePolicies') || hasOrgPermission(user, org, 'viewUsage');

/**
 * The billing owner or a platform admin, never anyone holding a role. Not a permission: it guards the
 * owner's own acts (ownership transfer, deleting the team, appointing managers), which no role can
 * be granted.
 */
export const isOrgOwnerOrPlatformAdmin = (
  user: { id: string; isAdmin?: boolean | null },
  org: { userId: string }
): boolean => user.isAdmin === true || org.userId === user.id;

/** The actor slice an administration decision needs - resolved from auth, never from the body. */
export type OrgAuthorityActor = OrgPermissionActor;

/** The organization slice an administration decision needs. */
export type AdministrableOrg = OrgRoleSubject;

/**
 * May this actor administer the organization's roster - remove members, or add them through the
 * direct `addMember` path? `manageMembers`.
 *
 * Deliberately NARROWER than `shareable.findAccessibleById`, which is a MEMBERSHIP ACL: it admits
 * anyone in `users[]` holding `read`, and `addMember` only ever grants `[Permission.read]`, so
 * every ordinary member satisfied it and could therefore enroll arbitrary accounts.
 *
 * Callers include `organizationService` `addMember` and `revokeAccess` (b4m-core/services), the
 * addUser route (apps/client/pages/api/organizations/[id]/addUser.ts) and the client's Members tab
 * (components/organizations/Member.tsx).
 */
export function canAdministerOrganization(actor: OrgAuthorityActor, organization: AdministrableOrg): boolean {
  return hasOrgPermission(actor, organization, 'manageMembers');
}

/**
 * May this actor remove `targetUserId` from the organization? `manageMembers`, and only the billing
 * owner or a platform admin may remove anyone who holds a role: removal also clears the target's
 * role, and role holders are the owner's to change.
 *
 * Enforced by `organizationService.revokeAccess`; the client's Members tab
 * (components/organizations/Member.tsx) asks it per card so it never offers a refused Revoke.
 */
export function canRevokeOrgMember(
  actor: OrgAuthorityActor,
  organization: AdministrableOrg,
  targetUserId: string
): boolean {
  if (!canAdministerOrganization(actor, organization)) return false;
  if (isOrgOwnerOrPlatformAdmin(actor, organization)) return true;
  // Keyed on the role lists rather than organizationMemberRole: a pending invitee has no users[] row
  // yet and stays revocable, while a stale list entry stays protected, as before roles existed.
  const privileged = [...(organization.adminUserIds ?? []), ...(organization.billingManagerUserIds ?? [])];
  return !privileged.includes(targetUserId);
}

export type OrganizationSeatUsage = { used: number; seats: number; full: boolean };

/**
 * Owner-inclusive seat usage: the owner holds a seat but no `users[]` row, so `used` is the roster
 * plus one and the org is full once that reaches `seats`. Pending invites are not counted. Shared by
 * `organizationService.addMember`'s capacity check and the admin console, so the two cannot drift.
 */
export const organizationSeatUsage = (org: {
  users?: ReadonlyArray<unknown> | null;
  seats: number;
}): OrganizationSeatUsage => {
  const used = (org.users?.length ?? 0) + 1;
  return { used, seats: org.seats, full: used >= org.seats };
};

/** Why an add is refused when `organizationSeatUsage(org).full`; shared by the admin dialog and route. */
export const organizationSeatsFullMessage = (name: string, seats: number): string =>
  `${name} uses ${seats === 1 ? 'its only paid seat' : `all ${seats} paid seats`}. Raise the seat count on its profile before adding anyone.`;

/**
 * May this user read the team audit trail (`pages/api/organizations/[id]/audit.ts`, the Audit tab)?
 * `viewAudit` from the user's own role - no platform-admin arm, admins read it from the admin
 * console - and a manager's row must also confer membership, a stricter row test than the role's.
 */
export const canReadOrganizationAudit = (
  user: { id: string } | null | undefined,
  org: (OrgRoleSubject & { users?: ReadonlyArray<{ userId: string; permissions?: readonly string[] | null }> | null }) | null | undefined
): boolean =>
  !!user &&
  !!org &&
  orgMemberHasPermission(org, user.id, 'viewAudit') &&
  (org.userId === user.id ||
    (org.users ?? []).some(row => row.userId === user.id && orgAclRowConfersMembership(row)));
