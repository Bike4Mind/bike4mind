import { broadcastSafeSettingKeys, InviteType } from '@bike4mind/common';
import type { mongoose } from '@bike4mind/database';

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

/**
 * Fan-out scope for AdminSettings subscriptions. The subscriber-fanout service relays the raw
 * stored document, and a per-query projection cannot mask per setting, so the scope itself keeps
 * sensitive settings out of the stream for every caller, admins included. Clients still get those
 * through the redacting REST reads; the admin settings mutation invalidates that cache on save.
 */
export function adminSettingsSubscriptionScope(
  abilityScope: mongoose.FilterQuery<unknown>
): mongoose.FilterQuery<unknown> {
  return { $and: [abilityScope, { settingName: { $in: broadcastSafeSettingKeys() } }] };
}
