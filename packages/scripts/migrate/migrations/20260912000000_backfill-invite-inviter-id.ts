import { Invite, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Backfills `Invite.inviterId` from the `username` every invite already persists.
 *
 * `inviterId` is what lets acceptInvite cap a propagated file grant at what the inviter actually
 * holds. Invites minted before the field existed have none, so acceptance falls back to a narrower
 * rule (propagate only to the session owner's own files). That fallback is fail-closed and correct,
 * but nothing retires it: invite expiry defaults ~100 years out, so without this backfill the
 * legacy population never ages out and two authorization semantics live side by side forever.
 *
 * Once this has run everywhere, the `else if (fabfile.userId === session.userId)` arm in
 * sharingService/accept.ts has no remaining input and can be deleted.
 *
 * Exact-match on username, not the collation-insensitive lookup createInvite uses: username
 * uniqueness on this schema is case-SENSITIVE, so a case-insensitive match can return two real
 * accounts for one string. Attributing an invite to the wrong inviter would widen what acceptance
 * propagates, so an ambiguous or missing match is skipped and left on the fallback.
 *
 * Idempotent: a second run matches nothing, because every row it touched now has an `inviterId`.
 */
const migration: MigrationFile = {
  id: 20260912000000,
  name: 'backfill-invite-inviter-id',

  up: async () => {
    const pending = await Invite.find({
      inviterId: { $exists: false },
      username: { $type: 'string', $ne: '' },
    }).select('username');

    if (pending.length === 0) {
      console.log('[backfill-invite-inviter-id] no invites missing inviterId');
      return;
    }

    const usernames = [...new Set(pending.map(invite => invite.username).filter((u): u is string => !!u))];
    const users = await User.find({ username: { $in: usernames } }).select('username');

    const byUsername = new Map<string, string[]>();
    for (const user of users) {
      if (!user.username) continue;
      byUsername.set(user.username, [...(byUsername.get(user.username) ?? []), String(user._id)]);
    }

    let updated = 0;
    let skipped = 0;
    for (const username of usernames) {
      const ids = byUsername.get(username) ?? [];
      if (ids.length !== 1) {
        skipped += 1;
        continue;
      }
      const result = await Invite.updateMany(
        { inviterId: { $exists: false }, username },
        { $set: { inviterId: ids[0] } }
      );
      updated += result.modifiedCount ?? 0;
    }

    console.log(
      `[backfill-invite-inviter-id] set inviterId on ${updated} invite(s); ` +
        `${skipped} username(s) skipped as unresolvable or ambiguous`
    );
  },

  // Irreversible by design: the pre-migration state is the absence of a field, and restoring it
  // would put those invites back on the narrower fallback for no benefit.
  down: async () => {
    console.log('[backfill-invite-inviter-id] no down migration; the backfill is additive');
  },
};

export default migration;
