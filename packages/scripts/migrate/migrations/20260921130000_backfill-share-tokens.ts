import { PublishedArtifact } from '@bike4mind/database';
import { Types } from 'mongoose';
import { type MigrationFile } from './index';

const LOG = '[backfill-share-tokens]';

interface LegacyRow {
  _id: Types.ObjectId;
  shareToken?: string;
  shareTokenUpdatedAt?: Date | null;
  publishedAt?: Date | null;
  shareTokens?: { token?: string }[];
}

/**
 * Seed `shareTokens` from the legacy scalar `shareToken`, so every live share link exists in
 * the array shape that per-link view counts and multiple-links-per-artifact are built on
 * (#3255 step 1). The scalar remains the source of truth and the mint/rotate race arbiter;
 * this only stops a pre-existing link from being invisible to the array readers.
 *
 * A read-then-write loop rather than a single pipeline `updateMany`: each entry needs a real
 * `_id` (it is the handle the owner UI revokes by) and an aggregation pipeline cannot mint one.
 *
 * Idempotent. The filter takes rows holding a scalar token, and the loop skips any whose array
 * already carries it, so a re-run - and a row the app itself already mirrored - are no-ops.
 *
 * The id is backdated below BackfillOAuthClientTokenEndpointAuthMethod's 20260922000001 on
 * purpose, the same way EnsureDataLakeInconsistencyScanIndex was: that migration is fail-closed
 * and its own test asserts it holds the highest id on disk, so anything sorting after it would be
 * blocked by its throw. Nothing here depends on running after the 20260922 migrations.
 *
 * Ordering against the deploy is not load-bearing here, unlike the data-lake origin backfill:
 * nothing stamps a schema default that would make a row unrepairable, and the readers tolerate
 * both shapes either way. Running it late just means those artifacts' links resolve via the
 * legacy branch until it does.
 */
const migration: MigrationFile = {
  id: 20260921130000,
  name: 'backfill-share-tokens',

  up: async () => {
    const rows = await PublishedArtifact.find({ shareToken: { $type: 'string' } })
      .select('shareToken shareTokenUpdatedAt publishedAt shareTokens.token')
      .lean<LegacyRow[]>();

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
                // Not "now": the owner surface shows when the link was created, and stamping
                // every migrated link with the deploy time would tell them the wrong thing.
                // `shareTokenUpdatedAt` is when it was last minted or rotated, the closest
                // truth on the row.
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
    console.log(`${LOG} ${rows.length} row(s) with a legacy token; mirrored ${ops.length} into shareTokens[]`);
  },

  // Drops ONLY the mirrored entries, matched by the scalar they were copied from, so a link
  // minted as an array entry by post-deploy app code survives a rollback. A revoked entry is
  // left alone even if its token matches: its token must stay claimed in the unique index,
  // which is what keeps a revoked link revoked.
  down: async () => {
    const result = await PublishedArtifact.updateMany({ shareToken: { $type: 'string' } }, [
      {
        $set: {
          shareTokens: {
            $filter: {
              input: { $ifNull: ['$shareTokens', []] },
              as: 'entry',
              cond: {
                $not: { $and: [{ $eq: ['$$entry.token', '$shareToken'] }, { $eq: ['$$entry.revokedAt', null] }] },
              },
            },
          },
        },
      },
    ]);
    console.log(`${LOG} down: reverted ${result.modifiedCount} row(s)`);
  },
};

export default migration;
