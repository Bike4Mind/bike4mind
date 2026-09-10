import { InviteType } from '@bike4mind/common';
import type { mongoose } from '@bike4mind/database';

/**
 * Fan-out scope for QuestMasterPlan change-stream subscriptions.
 *
 * Plan access is user-based (owner, shared collaborator, or public
 * visibility), while legacy plans (no userId) and session-visibility plans
 * are reachable through session membership. The subscription scope must
 * cover both dimensions; a session-only scope silently drops live updates
 * for shared collaborators who work from their own sessions and for plans
 * attached to placeholder notebook ids.
 *
 * The scope is ANDed with the client-supplied query, so the public arm only
 * streams documents the client explicitly subscribed to.
 */
export function questMasterPlanSubscriptionScope(
  userId: string,
  accessibleSessionIds: mongoose.Types.ObjectId[]
): mongoose.FilterQuery<unknown> {
  return {
    $or: [
      { userId },
      { sharedWith: userId },
      { visibility: 'public' },
      // Legacy plans (no userId) and session-visibility plans remain
      // reachable through the sessions the user can access
      { notebookId: { $in: accessibleSessionIds } },
    ],
  };
}

/**
 * Fan-out scope for Invite change-stream subscriptions: invites addressed to the caller's own
 * email, plus project invites for projects the caller may share.
 *
 * `pendingEmail` MUST be a real address. `recipients.pending` holds invitee emails, so an
 * emailless account can have no invites addressed to it - and passing `undefined` through to
 * `$in: [undefined]` makes Mongo read the arm as "field missing or null", which over-matches
 * every invite that has no pending array at all, i.e. other tenants' invites. A blank email
 * therefore drops the arm entirely rather than widening it - this mirrors the emailless guard in
 * InviteModel's own pendingEmailMatch, but NOT its matching semantics: pendingEmailMatch also ORs
 * in a case-insensitive `$regex` arm that this exact-`$in` match does not, a pre-existing
 * divergence this function doesn't change.
 */
export function inviteSubscriptionScope(
  pendingEmail: string | null | undefined,
  shareableProjectIds: string[]
): mongoose.FilterQuery<unknown> {
  const normalizedEmail = typeof pendingEmail === 'string' ? pendingEmail.trim() : '';
  return {
    $or: [
      ...(normalizedEmail ? [{ 'recipients.pending': { $in: [normalizedEmail] } }] : []),
      { $and: [{ type: InviteType.Project }, { documentId: { $in: shareableProjectIds } }] },
    ],
  };
}
