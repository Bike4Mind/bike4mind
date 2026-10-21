import { Types } from 'mongoose';
import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[move-quest-answeredby-to-redirectedfrom]';
// No quest older than this can carry answeredBy; bounds the scan to the _id index.
const ANSWERED_BY_SINCE = Types.ObjectId.createFromTime(Date.UTC(2026, 9, 1) / 1000);

/**
 * Moves the earlier `model.answeredBy` redirect record to `model.name` (answered) + `redirectedFrom` (requested).
 * Raw collection: `answeredBy` is gone from the Quest schema. Id stays below the oauth backfill, which must be highest.
 *
 * Two earlier shapes cannot be rewritten faithfully and are left alone:
 * - A redirect followed by a fallback overwrote both fields with the fallback id, so the requested id is already
 *   lost; `redirectedFrom` stays unset rather than pointing at the answering model.
 * - A redirect that then failed stored no `answeredBy` at all, so the filter skips it and `model.name` keeps the
 *   requested id. Nothing reads `redirectedFrom` on an error row, and the error reply suppresses the redirect label.
 */
const migration: MigrationFile = {
  id: 20260921235987,
  name: 'move-quest-answeredby-to-redirectedfrom',

  up: async () => {
    const result = await Quest.collection.updateMany(
      {
        _id: { $gte: ANSWERED_BY_SINCE },
        'promptMeta.model.answeredBy': { $type: 'string', $ne: '' },
      },
      [
        {
          $set: {
            // Only set redirectedFrom when answeredBy differs from name: equal values mean a fallback hop
            // overwrote name with the same answering id, so there is no requested id left to record.
            'promptMeta.redirectedFrom': {
              $ifNull: [
                '$promptMeta.redirectedFrom',
                {
                  $cond: [
                    { $ne: ['$promptMeta.model.answeredBy', '$promptMeta.model.name'] },
                    '$promptMeta.model.name',
                    '$$REMOVE',
                  ],
                },
              ],
            },
            'promptMeta.model.name': '$promptMeta.model.answeredBy',
          },
        },
        { $unset: 'promptMeta.model.answeredBy' },
      ]
    );
    console.log(`${LOG} matched ${result.matchedCount}, modified ${result.modifiedCount} quest(s)`);
  },

  // No-op: the old convention is not read anywhere, and the new fields are valid on their own.
  down: async () => {},
};

export default migration;
