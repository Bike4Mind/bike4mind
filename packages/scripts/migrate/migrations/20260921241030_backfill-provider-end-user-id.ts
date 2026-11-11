import { mongoose } from '@bike4mind/database';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { type MigrationFile } from './index';

const BATCH_SIZE = 1000;

// Index first, so lookups for users written by the new save hook are indexed while the backfill runs.
const migration: MigrationFile = {
  id: 20260921241030,
  name: 'backfill provider end user id',
  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');
    const users = db.collection('users');
    await users.createIndex({ providerEndUserId: 1 }, { name: 'user_providerEndUserId', sparse: true });
    const cursor = users.find({ providerEndUserId: { $exists: false } }, { projection: { _id: 1 } });
    let batch: Array<Parameters<typeof users.bulkWrite>[0][number]> = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await users.bulkWrite(batch, { ordered: false });
      batch = [];
    };
    try {
      for await (const user of cursor) {
        batch.push({
          updateOne: {
            filter: { _id: user._id, providerEndUserId: { $exists: false } },
            update: { $set: { providerEndUserId: toProviderEndUserId(String(user._id)) } },
          },
        });
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
    } finally {
      await cursor.close();
    }
  },
  down: async () => {
    // Additive: the field and index only serve admin lookups and are rewritten on every user save.
  },
};

export default migration;
