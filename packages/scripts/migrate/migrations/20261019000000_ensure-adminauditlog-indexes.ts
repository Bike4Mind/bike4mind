import { AdminAuditLogModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the AdminAuditLog query indexes. `autoIndex` is off in the deployed environments, so the
 * schema declarations never build there. Idempotent: createIndexes is a no-op for a matching index.
 */
const migration: MigrationFile = {
  id: 20261019000000,
  name: 'ensure adminauditlog indexes',

  up: async () => {
    await AdminAuditLogModel.createIndexes();
  },

  down: async () => {
    // One-way: the indexes are harmless to keep and the audit log is append-only.
  },
};

export default migration;
