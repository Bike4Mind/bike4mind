import { AdminUserNoteModel, AdminUserNoteRevisionModel } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260921235898,
  name: 'ensure admin user note indexes',
  up: async () => {
    await AdminUserNoteModel.createIndexes();
    await AdminUserNoteRevisionModel.createIndexes();
  },
  down: async () => {},
};
export default migration;
