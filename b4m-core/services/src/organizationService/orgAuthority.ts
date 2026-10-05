import type { IOrganization, IUserDocument } from '@bike4mind/common';

/** The actor slice an administration decision needs - resolved from auth, never from the body. */
export type OrgAuthorityActor = Pick<IUserDocument, 'id'> & { isAdmin?: boolean | null };

/** The organization slice an administration decision needs. */
export type AdministrableOrg = Pick<IOrganization, 'userId'> & { managerId?: string | null };

/**
 * May this actor administer the organization's roster - add or remove members?
 *
 * Deliberately NARROWER than `shareable.findAccessibleById`, which is a MEMBERSHIP ACL: it admits
 * anyone in `users[]` holding `read`, and `addMember` only ever grants `[Permission.read]`, so
 * every ordinary member satisfied it and could therefore enroll arbitrary accounts. Roster
 * administration is a billing-owner / manager / platform-admin decision, not a member one.
 *
 * `userId` and `managerId` are declared `String` on the organization schema (unlike the User-side
 * `organizationId` pointer, which is an ObjectId), so a strict comparison is correct here.
 *
 * The one predicate for this question: `addMember` and `revokeAccess` must agree on who may change
 * the roster, or one side of the membership lifecycle admits principals the other refuses. It
 * mirrors the route-layer `verifyOrgAccess` (apps/client/server/utils/orgAccess.ts), which asks the
 * same question of client-supplied org ids and must stay in sync with it.
 */
export function canAdministerOrganization(actor: OrgAuthorityActor, organization: AdministrableOrg): boolean {
  if (actor.isAdmin) return true;
  return organization.userId === actor.id || (!!organization.managerId && organization.managerId === actor.id);
}

/** The organization slice a membership decision needs: the roster plus its privileged principals. */
export type OrgMembershipRoster = AdministrableOrg & { users?: { userId: string }[] };

/**
 * Is this user a CURRENT member of the organization - billing owner, appointed manager, or a row in
 * the authoritative `users[]` ACL?
 *
 * Answers the question against an ALREADY-FETCHED organization document, so a caller that holds the
 * doc re-verifies attachment without a second query.
 *
 * NOT interchangeable with the repository's `findMembershipOrgIds`, and the difference is
 * deliberate on both sides. That predicate backs the READ SCOPE (which org's lakes and artifacts
 * you see) and so excludes `managerId` and requires a `users[]` row to hold a membership
 * permission - widening it would reach the org switcher and turn "may administer" into "may write
 * as". This one answers the narrower question "is this principal still attached to the org at
 * all", for a caller deciding whether a stale reference may still be honored, so it admits the
 * appointed manager (whom `assignManager` never adds to `users[]`) and any roster row regardless
 * of permissions. Revoking someone removes their row and their manager appointment; neither is
 * what this is guarding against being weakened by.
 *
 * No platform-admin arm: this reports a factual relationship to the roster, not authority. A
 * caller that wants "admin may act anyway" must say so itself, so the two ideas cannot be
 * conflated at a billing gate, where an admin's involvement should not change whose pool is spent.
 */
export function isCurrentOrgMember(organization: OrgMembershipRoster, userId: string): boolean {
  if (organization.userId === userId) return true;
  if (organization.managerId && organization.managerId === userId) return true;
  return (organization.users ?? []).some(member => member.userId?.toString() === userId);
}
