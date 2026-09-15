import { Project, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20251022125702,
  name: 'drop unused project unique name index',

  up: async () => {
    await safeDropIndex(Project.collection, 'name_1');
  },

  down: async () => {},
};

export default migration;
