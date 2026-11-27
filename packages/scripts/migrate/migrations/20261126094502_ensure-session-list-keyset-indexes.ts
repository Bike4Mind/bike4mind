import mongoose from 'mongoose';
import { Session } from '@bike4mind/database';
import type { MigrationFile } from './index';

/**
 * Build the own-session list indexes with an _id tiebreak (see SessionModel searchByUserId), then
 * drop the two they extend: each new index serves every query the old one did. The drop runs only
 * after createIndexes has finished building the replacements.
 */
const replacedIndexes = [
  { name: 'deletedAt_1_userId_1_lastUpdated_-1', key: { deletedAt: 1, userId: 1, lastUpdated: -1 } },
  {
    name: 'deletedAt_1_userId_1_origin.channel_1_lastUpdated_-1',
    key: { deletedAt: 1, userId: 1, 'origin.channel': 1, lastUpdated: -1 },
  },
] as const;

const migration: MigrationFile = {
  id: 20261126094502,
  name: 'ensure session list keyset indexes',

  up: async () => {
    await Session.createIndexes();
    const indexes = await Session.collection.indexes();
    for (const spec of replacedIndexes) {
      const existing = indexes.find(index => index.name === spec.name);
      if (!existing) continue;
      if (JSON.stringify(existing.key) !== JSON.stringify(spec.key) || existing.partialFilterExpression !== undefined)
        throw new Error(`Refusing to drop an unrecognized index: ${spec.name}`);
      try {
        await Session.collection.dropIndex(spec.name);
      } catch (error) {
        // 27: IndexNotFound, from a concurrent run.
        if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
      }
    }
  },

  // One-way: the replacements serve every query the dropped indexes did.
  down: async () => {},
};

export default migration;
