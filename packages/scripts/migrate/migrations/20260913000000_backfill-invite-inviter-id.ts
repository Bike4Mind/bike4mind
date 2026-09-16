import { Invite, Session, User } from '@bike4mind/database';
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
 * Two narrowings, both because `username` is MUTABLE and the resolution feeds an authorization
 * decision rather than a display string. A rename-then-reuse resolves to exactly one account - the
 * wrong one - and the ambiguity guard above never fires on it.
 *
 * First, Session invites only. `inviterId` has exactly one production reader, the Session arm of
 * sharingService/accept.ts, so setting it on any other type is risk with no benefit.
 *
 * Second, the resolved account has to be a principal on the session the invite targets: its owner,
 * or a holder of a grant in `users[]`. Minting the invite required share authority on that session,
 * so a correct resolution satisfies this and a stranger who merely holds the username now does not.
 * An invite whose inviter has since lost their grant fails it too and stays on the fallback, which
 * is the fail-closed direction - accept.ts propagates only to the session owner's own files when
 * `inviterId` is absent, so not resolving is strictly safer than resolving wrongly.
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

    let uncorroborated = 0;

    while (true) {
      const filter: Record<string, unknown> = {
        type: 'Session',
        inviterId: { $exists: false },
        username: { $type: 'string', $ne: '' },
      };
      if (lastId) filter._id = { $gt: lastId };

      const batch = await Invite.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).select('username documentId');
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

      // Per batch rather than cached across all of them: the batch bounds this at BATCH_SIZE
      // sessions, where a run-long cache is unbounded in a collection this size.
      const documentIds = [
        ...new Set(
          batch
            .filter(invite => !!invite.username && resolved.has(invite.username))
            .map(invite => invite.documentId)
            .filter((id): id is string => !!id)
        ),
      ];
      const principals = new Map<string, Set<string>>();
      if (documentIds.length > 0) {
        const sessions = await Session.find({ _id: { $in: documentIds } }).select('userId users');
        for (const session of sessions) {
          principals.set(
            String(session._id),
            new Set([
              String(session.userId),
              ...(session.users ?? []).map((entry: { userId?: unknown }) => String(entry?.userId)),
            ])
          );
        }
      }

      const writes = [];
      for (const invite of batch) {
        const inviterId = invite.username ? resolved.get(invite.username) : undefined;
        if (!inviterId) continue;
        if (!principals.get(String(invite.documentId))?.has(inviterId)) {
          uncorroborated += 1;
          continue;
        }
        writes.push({
          updateOne: { filter: { _id: invite._id }, update: { $set: { inviterId } } },
        });
      }

      if (writes.length > 0) {
        const result = await Invite.bulkWrite(writes, { ordered: false });
        updated += result.modifiedCount ?? 0;
      }

      lastId = batch[batch.length - 1]._id;
      if (batch.length < BATCH_SIZE) break;
    }

    console.log(
      `[backfill-invite-inviter-id] set inviterId on ${updated} Session invite(s); ` +
        `${unresolvable.size} username(s) skipped as unresolvable or ambiguous; ` +
        `${uncorroborated} invite(s) skipped because the resolved account is not a principal on the session`
    );
  },

  // Irreversible by design: the pre-migration state is the absence of a field, and restoring it
  // would put those invites back on the narrower fallback for no benefit.
  down: async () => {
    console.log('[backfill-invite-inviter-id] no down migration; the backfill is additive');
  },
};

export default migration;
