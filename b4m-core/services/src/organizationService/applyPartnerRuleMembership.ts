import { IOrganizationRepository, IUserDocument, IUserRepository, Permission } from '@bike4mind/common';

/**
 * Why the auto-add did or didn't happen - returned (not thrown) so the signup paths can
 * log the outcome without a failure here ever breaking verification, and so the backfill
 * route can tally results.
 */
export type ApplyPartnerRuleMembershipResult = {
  added: boolean;
  reason: 'added' | 'unverified' | 'user-missing' | 'org-missing' | 'already-member' | 'at-capacity';
};

interface ApplyPartnerRuleMembershipParams {
  userId: string;
  organizationId: string;
}

interface ApplyPartnerRuleMembershipAdapters {
  db: {
    users: IUserRepository;
    organizations: IOrganizationRepository;
  };
  logger?: { info: (message: string) => void };
}

/**
 * Add a user to an organization as the effect of a matched PartnerSignupRule - a SYSTEM
 * action with no acting admin, so it deliberately does not go through `addMember`'s
 * shareable-access gate. The membership shape it writes (a `users[]` read-permission entry
 * plus `user.organizationId`) MUST stay in sync with `addMember` / `leave`.
 *
 * Loads the user fresh by id rather than trusting a caller-supplied doc: the verify path
 * holds a pre-verification user object, and a full-doc write of that stale copy would revert
 * `emailVerified`. Gating on the freshly-read `emailVerified` also closes the hole where an
 * unverified address could land inside a partner's private org.
 *
 * Idempotent and additive: an existing member is never duplicated, and this never removes
 * anyone. Respects the org's seat cap (no silent overfill); at capacity it no-ops and the
 * caller logs, rather than forcing a billing change the admin didn't consent to per-signup.
 */
export async function applyPartnerRuleMembership(
  { userId, organizationId }: ApplyPartnerRuleMembershipParams,
  adapters: ApplyPartnerRuleMembershipAdapters
): Promise<ApplyPartnerRuleMembershipResult> {
  const { db, logger } = adapters;

  const user = await db.users.findById(userId);
  if (!user) return { added: false, reason: 'user-missing' };
  if (user.emailVerified !== true) return { added: false, reason: 'unverified' };

  // findById filters soft-deleted orgs, so a deleted org resolves to null here and fails
  // safe - no crash, no membership, the caller logs the dangling reference.
  const organization = await db.organizations.findById(organizationId);
  if (!organization) return { added: false, reason: 'org-missing' };

  const alreadyMember = organization.users.some(u => u.userId === userId);
  if (alreadyMember) {
    // Repair a half-set membership (in the ACL but organizationId never set) without
    // touching the org. Partial update so no other user field is disturbed.
    if (user.organizationId !== organizationId) {
      await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);
    }
    return { added: false, reason: 'already-member' };
  }

  if (organization.users.length >= organization.seats) {
    logger?.info(
      `Partner-rule auto-add skipped: organization ${organizationId} is at capacity (${organization.seats} seats)`
    );
    return { added: false, reason: 'at-capacity' };
  }

  organization.users.push({ userId, permissions: [Permission.read] });
  await db.organizations.update(organization);

  // Partial update - see the stale-doc note above.
  await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);

  logger?.info(`Partner-rule auto-added user ${userId} to organization ${organizationId}`);
  return { added: true, reason: 'added' };
}
