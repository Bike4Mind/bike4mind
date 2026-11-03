import { mongoose } from '@bike4mind/database';
import { DEFAULT_STORAGE_LIMIT_MB } from '@bike4mind/common';
import { type MigrationFile } from './index';

// Keep below the fail-closed OAuth migration, which must remain last.
const migration: MigrationFile = {
  id: 20260921235964,
  name: 'backfill storage limit overrides',
  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');
    const users = db.collection('users');
    const cursor = users.find({ storageLimitOverride: { $exists: false } }, { projection: { storageLimit: 1 } });
    try {
      for await (const user of cursor) {
        const override =
          typeof user.storageLimit === 'number' && user.storageLimit !== DEFAULT_STORAGE_LIMIT_MB
            ? user.storageLimit
            : null;
        // Recheck both fields so a concurrent admin edit cannot be replaced by a stale snapshot.
        await users.updateOne(
          { _id: user._id, storageLimitOverride: { $exists: false }, storageLimit: user.storageLimit ?? null },
          { $set: { storageLimitOverride: override } }
        );
      }
    } finally {
      await cursor.close();
    }
  },
  down: async () => {
    // Additive and irreversible: removing overrides would discard admin intent recorded after rollout.
  },
};

export default migration;
