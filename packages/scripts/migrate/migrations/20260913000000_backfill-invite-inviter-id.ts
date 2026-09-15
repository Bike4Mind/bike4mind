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
 * Re-running is a no-op only because the scan is narrowed to `inviterId: { $exists: false }`, which
 * is a property of the filter rather than of the write: anything that later unsets the field puts
 * those rows back in scope. `_id`-cursor batching, matching 20260707120000_backfill-credit-lots.ts,
 * since invites are one of the higher-cardinality collections and an unbounded find would hold the
 * whole matching set in memory at once.
 */

const BATCH_SIZE = 1000;

const migration: MigrationFile = {
  id: 20260913000000,
  name: 'backfill-invite-inviter-id',

  up: async () => {
    // Opaque on purpose: nothing here reads it, it only ever goes back to Mongo as a cursor.
    let lastId: unknown = null;
    let updated = 0;
    // Cached across batches so a username spanning several of them costs one User lookup, and so
    // the skipped count reports distinct usernames rather than one per invite.
    const resolved = new Map<string, string>();
    const unresolvable = new Set<string>();

    while (true) {
      const filter: Record<string, unknown> = {
        inviterId: { $exists: false },
        username: { $type: 'string', $ne: '' },
      };
      if (lastId) filter._id = { $gt: lastId };

      const batch = await Invite.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).select('username');
      if (batch.length === 0) break;

      const unseen = [
        ...new Set(
          batch
            .map(invite => invite.username)
            .filter((u): u is string => !!u && !resolved.has(u) && !unresolvable.has(u))
        ),
      ];

      if (unseen.length > 0) {
        const users = await User.find({ username: { $in: unseen } }).select('username');
        const byUsername = new Map<string, string[]>();
        for (const user of users) {
          if (!user.username) continue;
          byUsername.set(user.username, [...(byUsername.get(user.username) ?? []), String(user._id)]);
        }
        for (const username of unseen) {
          const ids = byUsername.get(username) ?? [];
          if (ids.length === 1) resolved.set(username, ids[0]);
          else unresolvable.add(username);
        }
      }

      const writes = batch
        .filter(invite => !!invite.username && resolved.has(invite.username))
        .map(invite => ({
          updateOne: {
            filter: { _id: invite._id },
            update: { $set: { inviterId: resolved.get(invite.username as string) } },
          },
        }));

      if (writes.length > 0) {
        const result = await Invite.bulkWrite(writes, { ordered: false });
        updated += result.modifiedCount ?? 0;
      }

      lastId = batch[batch.length - 1]._id;
      if (batch.length < BATCH_SIZE) break;
    }

    console.log(
      `[backfill-invite-inviter-id] set inviterId on ${updated} invite(s); ` +
        `${unresolvable.size} username(s) skipped as unresolvable or ambiguous`
    );
  },

  // Irreversible by design: the pre-migration state is the absence of a field, and restoring it
  // would put those invites back on the narrower fallback for no benefit.
  down: async () => {
    console.log('[backfill-invite-inviter-id] no down migration; the backfill is additive');
  },
};

export default migration;
