import { Types } from 'mongoose';
import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[move-quest-answeredby-to-redirectedfrom]';
// No quest older than this can carry answeredBy; bounds the scan to the _id index.
const ANSWERED_BY_SINCE = Types.ObjectId.createFromTime(Date.UTC(2026, 9, 1) / 1000);

/**
 * Moves the earlier `model.answeredBy` redirect record to `model.name` (answered) + `redirectedFrom` (requested).
 * Raw collection: `answeredBy` is gone from the Quest schema. Id stays below the oauth backfill, which must be highest.
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
            'promptMeta.redirectedFrom': { $ifNull: ['$promptMeta.redirectedFrom', '$promptMeta.model.name'] },
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
