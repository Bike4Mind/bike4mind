import { SideAppAlertState } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the declared indexes of the side app alert state collection, and only that collection's.
 * The partial unique index on open alerts is what stops two runs both opening, and so both
 * sending, the same alert. Idempotent: createIndex is a no-op for an identical existing index.
 */
const migration: MigrationFile = {
  id: 20261118144000,
  name: 'ensure side app alert state indexes',

  up: async () => {
    const specs = SideAppAlertState.schema.indexes();
    if (specs.length === 0) {
      throw new Error('SideAppAlertState declares no indexes; this migration no longer matches its schema');
    }
    for (const [fields, options] of specs) {
      // mongoose and the driver type index keys and options differently; the values are the same.
      type CreateIndexArgs = Parameters<typeof SideAppAlertState.collection.createIndex>;
      await SideAppAlertState.collection.createIndex(fields as CreateIndexArgs[0], options as CreateIndexArgs[1]);
    }
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
