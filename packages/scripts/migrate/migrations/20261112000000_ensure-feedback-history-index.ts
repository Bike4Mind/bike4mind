import { AdminAuditLogModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20261112000000,
  name: 'ensure feedback history index',
  up: async () => {
    await AdminAuditLogModel.createIndexes();
  },
  down: async () => {
    // Additive: retain the index for history readers during a rollback.
  },
};

export default migration;
