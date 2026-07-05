import { FabFile } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20250107123500,
  name: 'remove chunk and vector files from FabFile collection',

  up: async () => {
    await FabFile.deleteMany({ parentId: { $exists: true } });
  },

  down: async () => {},
};

export default migration;
