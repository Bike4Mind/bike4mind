import { IOrganizationRepository, IUserDocument, IUserRepository, Permission } from '@bike4mind/common';

/**
 * Why the auto-add did or didn't happen - returned (not thrown) so the signup paths can
 * log the outcome without a failure here ever breaking verification, and so the backfill
 * route can tally results.
 */
export type ApplyPartnerRuleMembershipResult = {
  added: boolean;
  // 'added-seat-raised' (#1239): the org was at capacity and the seat ceiling was raised to admit
  // the domain-verified user (vs a plain 'added' that fit under the existing ceiling). The signup
  // caller fires the human alert + audit off this reason. There is no longer an 'at-capacity'
  // outcome - the auto-add path raises to fit rather than rejecting.
  reason: 'added' | 'added-seat-raised' | 'unverified' | 'user-missing' | 'org-missing' | 'already-member';
  /** Seat ceiling before/after the add; present on an 'added' or 'added-seat-raised' outcome. */
  previousSeats?: number;
  newSeats?: number;
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
 * anyone. At capacity it raises the seat ceiling to admit the user rather than rejecting a
 * legit domain signup at the door (#1239); the caller is responsible for the resulting alert +
 * audit so the billing owner's grown seat count is never a silent change.
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

  // Atomic add + raise the seat ceiling to fit (#1239): a domain-verified signup is never
  // rejected at capacity (Ken's call - blocking a legit partner user at the door is the worst
  // outcome). `addMemberRaisingSeats` is race-safe (idempotent on a duplicate; raises seats only
  // to the real post-add member count), so concurrent signups can't double-raise.
  const previousSeats = organization.seats;
  const updated = await db.organizations.addMemberRaisingSeats(organizationId, {
    userId,
    permissions: [Permission.read],
  });
  if (!updated) {
    // Lost the race: a concurrent signup already added this user. Ensure their org pointer is set
    // (mirrors the already-member repair above) and report it as such rather than a fresh add.
    if (user.organizationId !== organizationId) {
      await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);
    }
    return { added: false, reason: 'already-member' };
  }

  // Partial update - see the stale-doc note above.
  await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);

  const seatCeilingRaised = updated.seats > previousSeats;
  // Logged here for the CloudWatch trail; the human ALERT + audit record fire at the signup caller
  // off the 'added-seat-raised' reason, so this core service stays free of Slack/audit ports.
  logger?.info(
    seatCeilingRaised
      ? `Partner-rule raised organization ${organizationId} seat ceiling ${previousSeats} -> ${updated.seats} to admit user ${userId}`
      : `Partner-rule auto-added user ${userId} to organization ${organizationId}`
  );
  return {
    added: true,
    reason: seatCeilingRaised ? 'added-seat-raised' : 'added',
    previousSeats,
    newSeats: updated.seats,
  };
}
