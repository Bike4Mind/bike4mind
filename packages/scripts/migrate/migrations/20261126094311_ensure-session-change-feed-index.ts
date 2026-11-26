import { Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the (userId, updatedAt, _id) session index behind GET /api/v1/sessions?updated_since, the
 * change feed Desktop's web sync polls. `autoIndex` is off in the deployed environments.
 *
 * Builds only that index, not the schema's other declared ones: an environment's existing index can
 * differ from the schema, and the resulting conflict would fail the deploy. Idempotent: createIndex
 * is a no-op for an identical index that already exists.
 */
const isChangeFeedIndex = (fields: Record<string, unknown>): boolean =>
  Object.keys(fields).join(',') === 'userId,updatedAt,_id';

const migration: MigrationFile = {
  id: 20261126094311,
  name: 'ensure session change feed index',

  up: async () => {
    const specs = Session.schema.indexes().filter(([fields]) => isChangeFeedIndex(fields));
    if (specs.length !== 1) {
      throw new Error(
        'SessionModel no longer declares the change feed index; this migration no longer matches its schema'
      );
    }
    const [[fields, options]] = specs;
    // mongoose and the driver type index keys and options differently; the values are the same.
    type CreateIndexArgs = Parameters<typeof Session.collection.createIndex>;
    await Session.collection.createIndex(fields as CreateIndexArgs[0], options as CreateIndexArgs[1]);
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
