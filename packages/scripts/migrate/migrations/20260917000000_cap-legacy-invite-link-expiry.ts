import { isLinkOnlyInvite, type IInviteDocument } from '@bike4mind/common';
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
 * Scoped to tokenless LINK invites, and the scope is the point. Holding the id is the entire
 * authorization for a link invite, which is what makes the id door a hole worth closing on a clock.
 * A named invite re-checks the caller's email or their share authority at every door, so its id is
 * an address rather than a secret - and the inbox, whose projection carries no token, has no other
 * key to address it with. Capping a named invite would therefore expire a working share early and
 * buy nothing. Membership is decided by `isLinkOnlyInvite` rather than by a hand-rolled query, so
 * the population this migration touches is exactly the one whose id door the resolver leaves open.
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
    let skippedNamed = 0;

    while (true) {
      const filter: Record<string, unknown> = {
        token: { $exists: false },
        // Absent as well as far-future: an invite with no expiry at all is the same unbounded door,
        // and the redemption paths treat a missing `expiresAt` as "never expires".
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: deadline } }],
      };
      if (lastId) filter._id = { $gt: lastId };

      const batch = await Invite.find(filter)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .select('_id isLinkOnly recipients type');
      if (batch.length === 0) break;

      // Keyset cursor advances on the RAW batch, not the filtered one, or a page of named invites
      // would stall the walk.
      lastId = batch[batch.length - 1]._id;

      const linkOnly = batch.filter(invite => isLinkOnlyInvite(invite as unknown as IInviteDocument));
      skippedNamed += batch.length - linkOnly.length;

      if (linkOnly.length > 0) {
        const result = await Invite.bulkWrite(
          linkOnly.map(invite => ({
            updateOne: { filter: { _id: invite._id }, update: { $set: { expiresAt: deadline } } },
          })),
          { ordered: false }
        );
        updated += result.modifiedCount ?? 0;
      }

      if (batch.length < BATCH_SIZE) break;
    }

    console.log(
      `[cap-legacy-invite-link-expiry] capped ${updated} tokenless link invite(s) to ${deadline.toISOString()} ` +
        `(${GRACE_DAYS}-day grace window for links already sent); left ${skippedNamed} named invite(s) alone`
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
