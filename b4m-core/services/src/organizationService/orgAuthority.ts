import type { AdministrableOrg } from '@bike4mind/common';

// The roster-administration predicate lives in @bike4mind/common so the client can gate its
// controls on the same answer the server enforces.
export { canAdministerOrganization } from '@bike4mind/common';
export type { AdministrableOrg, OrgAuthorityActor } from '@bike4mind/common';

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
 *
 * The repository's `setMemberMaxCredits` encodes the same three tiers as a Mongo `$or` and must
 * stay in sync with this.
 */
export function isCurrentOrgMember(organization: OrgMembershipRoster, userId: string): boolean {
  if (organization.userId === userId) return true;
  if (organization.managerId && organization.managerId === userId) return true;
  return (organization.users ?? []).some(member => member.userId?.toString() === userId);
}
