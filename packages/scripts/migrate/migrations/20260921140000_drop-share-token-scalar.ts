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
 * Retire the legacy `shareToken` / `shareTokenUpdatedAt` scalars; `shareTokens[]` is the only
 * representation of a share link. Only safe once no deployed build reads the scalars (a
 * deployment precondition, see the PR).
 *
 * Three steps, in this order:
 *   1. Mirror any remaining scalar-only live link into the array (normally a no-op), so the
 *      link is not silently killed.
 *   2. `$unset` both fields everywhere.
 *   3. Drop the `{ shareToken: 1 }` partial-unique index; unsetting the field leaves it behind.
 *
 * Step 1 precedes step 2 because step 2 destroys step 1's input. A crash between them leaves
 * the pre-migration state plus some healed rows, and a re-run finishes the job (idempotent:
 * step 1 skips rows already carrying the token, `$unset` of an absent field and
 * `safeDropIndex` of a dropped index are no-ops).
 *
 * Id is backdated to sit above the 20260921130000 backfill it depends on and below
 * 20260922000001, a fail-closed migration whose test asserts it holds the highest id on disk. A
 * higher id would sit behind its throw; the runner selects by applied-set, so a lower id still
 * runs.
 */
const migration: MigrationFile = {
  id: 20260921140000,
  name: 'drop-share-token-scalar',

  up: async () => {
    // Step 1. Read-then-write rather than a pipeline `updateMany`: each entry needs a real `_id`
    // (the handle the owner UI revokes by) and an aggregation pipeline cannot mint one.
    const rows = await PublishedArtifact.find({ shareToken: { $type: 'string' } })
      .select('shareToken shareTokenUpdatedAt publishedAt shareTokens.token shareTokens.revokedAt')
      .lean<LegacyRow[]>();

    // Matched on the token alone, revoked entries included: a revoked entry means the link was
    // deliberately killed, and re-adding it live would resurrect it (the unique index would also
    // reject the duplicate).
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
                // Not "now": the owner surface shows creation time. Same fallback chain as the
                // 20260921130000 backfill, so a row healed by either lands identically.
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

    // Step 2, through the RAW collection: with these paths gone from the schema, Mongoose strict
    // mode strips them from an update document, so `PublishedArtifact.updateMany` with `$unset`
    // reports rows modified while unsetting nothing. `.collection` bypasses strict mode. (Step
    // 1's `find` and the `down` aggregation pipeline are not subject to this.)
    //
    // The filter matches either key: `shareTokenUpdatedAt` had a schema default of null, so rows
    // carry it even with no link ever minted.
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
   * NOT strictly reversible: if the newest live link was revoked since `up` ran, the original
   * scalar pointed at a different, now-revoked entry and nothing records which. This restores
   * what the old build would mirror today, which is right for a rollback and wrong for an audit.
   *
   * Rows with no live link get no scalar at all.
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

    // Recreated so a rolled-back build finds the index its `/a/<token>` lookups expect.
    await PublishedArtifact.collection.createIndex(
      { shareToken: 1 },
      { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } }
    );
    console.log(`${LOG} down: restored the legacy scalars on ${result.modifiedCount} row(s)`);
  },
};

export default migration;
