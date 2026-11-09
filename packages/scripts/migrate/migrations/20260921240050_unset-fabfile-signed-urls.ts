import { Types } from 'mongoose';
import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[unset-fabfile-signed-urls]';
const BATCH_SIZE = 1000;

/**
 * Removes the signed-URL fields that FabFile rows used to persist; readers now sign on demand.
 * Raw collection so soft-deleted rows are included. Id stays below the oauth backfill, which must be highest.
 */
const migration: MigrationFile = {
  id: 20260921240050,
  name: 'unset-fabfile-signed-urls',

  up: async () => {
    let last: Types.ObjectId | undefined;
    let total = 0;
    for (;;) {
      const batch = await FabFile.collection
        .find(
          {
            ...(last && { _id: { $gt: last } }),
            $or: [
              { fileUrl: { $exists: true } },
              { fileUrlExpireAt: { $exists: true } },
              { presignedUrl: { $exists: true } },
            ],
          },
          { projection: { _id: 1 } }
        )
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();
      if (batch.length === 0) break;

      const ids = batch.map(doc => doc._id);
      await FabFile.collection.updateMany(
        { _id: { $in: ids } },
        { $unset: { fileUrl: '', fileUrlExpireAt: '', presignedUrl: '' } }
      );
      total += ids.length;
      last = ids[ids.length - 1] as Types.ObjectId;
    }
    console.log(`${LOG} unset signed URL fields on ${total} file(s)`);
  },

  // No-op: the removed values were short-lived signed URLs and are re-signed on read.
  down: async () => {},
};

export default migration;
