import { PublishedArtifact, safeDropIndex } from '@bike4mind/database';
import { Types } from 'mongoose';
import { type MigrationFile } from './index';

const LOG = '[drop-share-token-scalar]';

interface LegacyRow {
  _id: Types.ObjectId;
  shareToken?: string;
  shareTokenUpdatedAt?: Date | null;
  publishedAt?: Date | null;
  shareTokens?: { token?: string; revokedAt?: Date | null }[];
}

/**
 * Retire the legacy `shareToken` / `shareTokenUpdatedAt` scalars now that `shareTokens[]` is the
 * only representation of a share link (#3523, the tail of #3255 step 3).
 *
 * #3488 moved the source of truth onto the array but kept writing the scalars, mirrored to the
 * newest live entry, purely as a rollback escape hatch: a build that still read them would then
 * serve a link. That hatch is only safe to remove once no deployed build reads them, which is a
 * DEPLOYMENT precondition, not a code one - see the PR.
 *
 * THREE steps, in this order, and the order matters:
 *
 *   1. Mirror any remaining scalar-only live link INTO the array. #3488's `additional` path
 *      already self-heals such a row on first use, so anything still in this state has not been
 *      touched since before the 20260921130000 backfill. Mirroring rather than letting it lapse
 *      is the safer default: the alternative silently kills a link someone may still be holding,
 *      and it is the same few lines the backfill already ran. Normally a no-op.
 *   2. `$unset` both fields everywhere.
 *   3. Drop the `{ shareToken: 1 }` partial-unique index. Unsetting the field alone would leave
 *      the index in place, and a stale unique index over a path no document has is both dead
 *      weight and a trap for the next person who reintroduces the field name for anything.
 *
 * Step 1 before step 2 because step 2 destroys the input to step 1. A crash between them leaves
 * links mirrored but scalars still present, which is exactly the pre-migration state plus some
 * healed rows - safe, and a re-run finishes the job.
 *
 * IDEMPOTENT. Step 1 skips a row whose array already carries the token, step 2's `$unset` on an
 * absent field is a no-op, and `safeDropIndex` tolerates an already-dropped index.
 *
 * ID BACKDATED to 20260921140000, above the 20260921130000 backfill it depends on and below
 * BackfillOAuthClientTokenEndpointAuthMethod's 20260922000001, for the reason the backfill
 * documents: that migration is fail-closed and its own test asserts it holds the highest id on
 * disk, so anything sorting after it would sit behind its throw and never run. Nothing here needs
 * to run after the 20260922 migrations.
 */
const migration: MigrationFile = {
  id: 20260921140000,
  name: 'drop-share-token-scalar',

  up: async () => {
    // Step 1. Read-then-write rather than a pipeline `updateMany`, for the reason the backfill
    // gives: each entry needs a real `_id` (the handle the owner UI revokes by) and an
    // aggregation pipeline cannot mint one.
    const rows = await PublishedArtifact.find({ shareToken: { $type: 'string' } })
      .select('shareToken shareTokenUpdatedAt publishedAt shareTokens.token shareTokens.revokedAt')
      .lean<LegacyRow[]>();

    // Matched on the token ALONE, revoked entries included. A row whose array holds the scalar's
    // token as a REVOKED entry has already had that link deliberately killed; re-adding it live
    // would resurrect a revoked link, and the unique index would reject the duplicate anyway.
    const ops = rows
      .filter(row => !(row.shareTokens ?? []).some(entry => entry.token === row.shareToken))
      .map(row => ({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $push: {
              shareTokens: {
                _id: new Types.ObjectId(),
                token: row.shareToken,
                // Not "now": the owner surface shows when the link was created, and stamping a
                // migrated link with the deploy time would tell them the wrong thing. Same
                // fallback chain as the backfill, so a row healed by either lands identically.
                createdAt: row.shareTokenUpdatedAt ?? row.publishedAt ?? new Date(),
                revokedAt: null,
                viewCount: 0,
                lastViewedAt: null,
              },
            },
          },
        },
      }));

    if (ops.length) await PublishedArtifact.bulkWrite(ops);
    console.log(`${LOG} ${rows.length} row(s) still held a scalar token; mirrored ${ops.length} into shareTokens[]`);

    // Step 2, through the RAW collection rather than the Mongoose model.
    //
    // This is the trap in the whole migration: the same change that removes these fields from the
    // schema makes Mongoose's strict mode strip them out of an UPDATE DOCUMENT, not just an
    // insert. `PublishedArtifact.updateMany(..., { $unset: { shareToken: '' } })` therefore
    // reports rows modified while unsetting nothing, and the fields survive the migration
    // silently. `.collection` bypasses casting and strict mode, so the $unset reaches the server
    // as written. (The `find` in step 1 needs no such treatment - query filters are not strict -
    // and the `down` pipeline below is an aggregation pipeline, which Mongoose passes through.)
    //
    // Matched on either key, not just the token: `shareTokenUpdatedAt` had a schema default of
    // null, so rows carry it even with no link ever minted, and a filter on the token alone would
    // leave every one of those behind.
    const unset = await PublishedArtifact.collection.updateMany(
      { $or: [{ shareToken: { $exists: true } }, { shareTokenUpdatedAt: { $exists: true } }] },
      { $unset: { shareToken: '', shareTokenUpdatedAt: '' } }
    );
    console.log(`${LOG} unset the legacy scalars on ${unset.modifiedCount} row(s)`);

    // Step 3.
    await safeDropIndex(PublishedArtifact.collection, 'shareToken_1');
  },

  /**
   * Restore the scalars from the newest live entry, and the index with them, so a rollback to a
   * build that reads them still serves a link.
   *
   * NOT reversible in the strict sense, and the gap is worth naming: for a row whose newest live
   * link has been revoked since `up` ran, the scalar at that time pointed at a DIFFERENT (now
   * revoked) entry, and nothing on the row records which. This restores what a pre-#3523 build
   * would mirror TODAY rather than what the field literally held then - which is the useful
   * answer for a rollback (that build would re-derive the same value on the next write) and the
   * wrong answer for an audit. Nobody should be auditing a field that no longer exists.
   *
   * Rows with no live link get no scalar at all, which is what an artifact that was never shared
   * has always looked like.
   */
  down: async () => {
    const result = await PublishedArtifact.updateMany({}, [
      {
        $set: {
          __live: {
            $filter: {
              input: { $ifNull: ['$shareTokens', []] },
              as: 'entry',
              cond: {
                $and: [
                  { $eq: [{ $ifNull: ['$$entry.revokedAt', null] }, null] },
                  { $eq: [{ $type: '$$entry.token' }, 'string'] },
                ],
              },
            },
          },
        },
      },
      {
        // Its own stage because it reads the $filter's output: a single $set sees the pre-update
        // document for every path it references.
        $set: {
          shareToken: { $ifNull: [{ $last: '$__live.token' }, '$$REMOVE'] },
          shareTokenUpdatedAt: { $ifNull: [{ $last: '$__live.createdAt' }, null] },
        },
      },
      { $unset: '__live' },
    ]);

    // Recreated to match the definition #3523 removed from the schema, so a rolled-back build
    // finds the index its `/a/<token>` lookups expect rather than collection-scanning.
    await PublishedArtifact.collection.createIndex(
      { shareToken: 1 },
      { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } }
    );
    console.log(`${LOG} down: restored the legacy scalars on ${result.modifiedCount} row(s)`);
  },
};

export default migration;
