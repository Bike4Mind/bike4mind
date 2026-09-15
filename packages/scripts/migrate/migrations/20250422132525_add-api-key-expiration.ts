import { ApiKey } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250422132525,
  name: 'add-api-key-expiration',

  up: async () => {
    const keysToUpdate = await ApiKey.find({
      expiresAt: { $exists: false },
      isActive: true,
    });

    if (keysToUpdate.length === 0) return;

    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days from now

    await Promise.allSettled(
      keysToUpdate.map(async key => {
        if (key.expiresAt) {
          return;
        }

        key.expiresAt = expiresAt;
        await key.save();
      })
    );
  },

  down: async () => {
    // Optional rollback - removes expiration dates
    await ApiKey.updateMany({ expiresAt: { $exists: true } }, { $unset: { expiresAt: '' } });
  },
};

export default migration;
