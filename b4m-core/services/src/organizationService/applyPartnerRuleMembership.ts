import { IOrganizationRepository, IUserDocument, IUserRepository, Permission } from '@bike4mind/common';

/**
 * Why the auto-add did or didn't happen - returned (not thrown) so the signup paths can
 * log the outcome without a failure here ever breaking verification, and so the backfill
 * route can tally results.
 *
 * Discriminated on `added` so the compiler ties `previousSeats`/`newSeats` to the outcomes that
 * carry them - no non-null assertions at the call sites:
 *  - 'added'             fit under the existing ceiling; seats unchanged.
 *  - 'added-seat-raised' the org was at capacity and the ceiling was raised to admit the user
 *                        (#1239, non-Stripe orgs only). The signup caller fires the alert + audit.
 *  - 'at-capacity'       a Stripe-billed org was full and its ceiling is deliberately NOT raised
 *                        out of band; the caller alerts an admin to add seats through billing.
 */
export type ApplyPartnerRuleMembershipResult =
  | { added: true; reason: 'added' | 'added-seat-raised'; previousSeats: number; newSeats: number }
  | { added: false; reason: 'unverified' | 'user-missing' | 'org-missing' | 'already-member' }
  | { added: false; reason: 'at-capacity'; seats: number };

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
 * Idempotent and additive: an existing member is never duplicated, and this never removes anyone.
 * At capacity the behaviour splits on how the org is billed (#1239):
 *  - NOT Stripe-billed: raise the seat ceiling to admit the user rather than rejecting a legit
 *    domain signup at the door; the caller fires the resulting alert + audit so the grown seat
 *    count is never a silent change.
 *  - Stripe-billed: do NOT raise the ceiling out of band (a raise Stripe doesn't know about is
 *    force-reverted by the next `customer.subscription.updated` webhook, which floors seat count at
 *    `users.length + 1 + pendingInvites` and force-writes back to Stripe's quantity). Reject with
 *    'at-capacity' so the caller can alert an admin to add seats through the billing-aware path.
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
    await repairOrgPointer(user, userId, organizationId, db);
    return { added: false, reason: 'already-member' };
  }

  const member = { userId, permissions: [Permission.read] };
  const isStripeBilled = !!organization.stripeCustomerId;

  // Stripe-billed org: add only if it fits under the current ceiling, never raising it (see the
  // doc comment above). A null result means already-member, org-gone, or at-capacity - re-read to
  // tell them apart precisely rather than blindly writing an org pointer or mislabelling a reject.
  if (isStripeBilled) {
    const pre = await db.organizations.addMemberIfUnderCeiling(organizationId, member);
    if (!pre) {
      const outcome = await inspectAfterNoMatch(organizationId, userId, db);
      if (outcome.state === 'gone') return { added: false, reason: 'org-missing' };
      if (outcome.state === 'member') {
        await repairOrgPointer(user, userId, organizationId, db);
        return { added: false, reason: 'already-member' };
      }
      logger?.info(
        `Partner-rule did not add user ${userId} to Stripe-billed org ${organizationId}: at capacity ` +
          `(seats ${outcome.seats}); ceiling not raised out of band, alerting an admin to add seats`
      );
      return { added: false, reason: 'at-capacity', seats: outcome.seats };
    }
    await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);
    logger?.info(
      `Partner-rule auto-added user ${userId} to Stripe-billed org ${organizationId} under the existing ceiling`
    );
    return { added: true, reason: 'added', previousSeats: pre.seats, newSeats: pre.seats };
  }

  // Non-Stripe org: atomic add + raise the seat ceiling to fit (#1239). `addMemberRaisingSeats` is
  // race-safe (idempotent on a duplicate; raises seats only to the real post-add member count) and
  // returns the pre-image, so before/after seats come from one atomically-matched document.
  const pre = await db.organizations.addMemberRaisingSeats(organizationId, member);
  if (!pre) {
    const outcome = await inspectAfterNoMatch(organizationId, userId, db);
    if (outcome.state === 'gone') return { added: false, reason: 'org-missing' };
    // 'member' (a concurrent signup won the race) or the vanishingly-rare 'absent' anomaly (the org
    // exists but the guarded add matched nothing without a capacity guard) - both are safe no-ops.
    if (outcome.state === 'member') {
      await repairOrgPointer(user, userId, organizationId, db);
    }
    return { added: false, reason: 'already-member' };
  }

  await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);

  const previousSeats = pre.seats;
  // Mirror the model's `$max($seats, $size(users) + 1)`: the pre-image `users` is the pre-add array,
  // so `users.length + 1` is the post-add member count the pipeline raised `seats` to.
  const newSeats = Math.max(pre.seats, pre.users.length + 1);
  const seatCeilingRaised = newSeats > previousSeats;
  // Logged here for the CloudWatch trail; the human ALERT + audit record fire at the signup caller
  // off the 'added-seat-raised' reason, so this core service stays free of Slack/audit ports.
  logger?.info(
    seatCeilingRaised
      ? `Partner-rule raised organization ${organizationId} seat ceiling ${previousSeats} -> ${newSeats} to admit user ${userId}`
      : `Partner-rule auto-added user ${userId} to organization ${organizationId}`
  );
  return {
    added: true,
    reason: seatCeilingRaised ? 'added-seat-raised' : 'added',
    previousSeats,
    newSeats,
  };
}

/** Set the user's org pointer if unset - a partial update so no other user field is disturbed. */
async function repairOrgPointer(
  user: { organizationId?: string | null },
  userId: string,
  organizationId: string,
  db: ApplyPartnerRuleMembershipAdapters['db']
): Promise<void> {
  if (user.organizationId !== organizationId) {
    await db.users.update({ id: userId, organizationId } as Partial<IUserDocument>);
  }
}

/**
 * Re-read the org after an atomic add matched no document, to tell apart the causes the guarded
 * update collapses into a single null: the org vanished mid-flight ('gone'), a concurrent signup
 * already added this user ('member'), or the user is genuinely absent - at capacity on the Stripe
 * path ('absent'). Distinguishing them keeps us from mislabelling a reject or writing an org
 * pointer to a deleted org.
 */
async function inspectAfterNoMatch(
  organizationId: string,
  userId: string,
  db: ApplyPartnerRuleMembershipAdapters['db']
): Promise<{ state: 'gone' } | { state: 'member' } | { state: 'absent'; seats: number }> {
  const fresh = await db.organizations.findById(organizationId);
  if (!fresh) return { state: 'gone' };
  if (fresh.users.some(u => u.userId === userId)) return { state: 'member' };
  return { state: 'absent', seats: fresh.seats };
}
