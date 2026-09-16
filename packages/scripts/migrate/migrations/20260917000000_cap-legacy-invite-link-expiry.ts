import { Invite } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Puts a deadline on the legacy `_id`-addressed share links.
 *
 * Every invite minted since the token cutover carries a CSPRNG `token` and is addressable only by
 * it. Invites minted before carry none, and `resolveRedeemableInvite` still admits their `_id` so
 * the links already sitting in people's inboxes keep working. That fallback is the whole hole the
 * token replaced - an ObjectId is only partially random and is disclosed by every surface that
 * lists invites - so it must not be open forever.
 *
 * `createInvite` defaults `expiresAt` to ~100 years out, so the legacy population does not age out
 * on its own; left alone the weak door stays open for the life of the product. This caps those rows
 * to a short window, after which the expiry check that every redemption path already applies closes
 * the door for good and the fallback arm in `resolveRedeemableInvite` has no remaining input.
 *
 * Scoped to tokenless invites only. A tokenized invite is already unreachable by id, so shortening
 * its life would break a working share for no security gain.
 *
 * Only ever shortens. An invite already expiring sooner than the cap keeps its own date: `$gt` in
 * the filter is what makes that true, and it is also what makes a re-run a no-op rather than a
 * rolling extension of the deadline every time the migration is executed.
 */

const GRACE_DAYS = 30;
const BATCH_SIZE = 1000;

const migration: MigrationFile = {
  id: 20260917000000,
  name: 'cap-legacy-invite-link-expiry',

  up: async () => {
    const deadline = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);
    let lastId: unknown = null;
    let updated = 0;

    while (true) {
      const filter: Record<string, unknown> = {
        token: { $exists: false },
        // Absent as well as far-future: an invite with no expiry at all is the same unbounded door,
        // and the redemption paths treat a missing `expiresAt` as "never expires".
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: deadline } }],
      };
      if (lastId) filter._id = { $gt: lastId };

      const batch = await Invite.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).select('_id');
      if (batch.length === 0) break;

      const result = await Invite.bulkWrite(
        batch.map(invite => ({
          updateOne: { filter: { _id: invite._id }, update: { $set: { expiresAt: deadline } } },
        })),
        { ordered: false }
      );
      updated += result.modifiedCount ?? 0;

      lastId = batch[batch.length - 1]._id;
      if (batch.length < BATCH_SIZE) break;
    }

    console.log(
      `[cap-legacy-invite-link-expiry] capped ${updated} tokenless invite(s) to ${deadline.toISOString()} ` +
        `(${GRACE_DAYS}-day grace window for links already sent)`
    );
  },

  // Irreversible by design: the prior value was an unbounded default, and restoring it would reopen
  // the very door this exists to close. An individual share that genuinely needs longer is re-sent,
  // which mints a tokenized invite.
  down: async () => {
    console.log('[cap-legacy-invite-link-expiry] no down migration; restoring the old expiry would reopen the id door');
  },
};

export default migration;
