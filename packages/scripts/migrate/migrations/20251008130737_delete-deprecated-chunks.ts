import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251008130737,
  name: 'delete deprecated chunks',

  up: async () => {
    const result = await FabFile.deleteMany({ parentId: { $exists: true } }, { hardDelete: true } as any);
    console.log(`Deleted ${result.deletedCount} deprecated chunks`);
  },

  down: async () => {
    // No down migration
  },
};

export default migration;
