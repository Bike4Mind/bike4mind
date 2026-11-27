import { Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the partial `sessionId_pendingActionTs` index on quests, which serves the pending-decisions count and
 * the brief's open approvals. The partial filter keeps it to quests parked on an approval, but the build still
 * reads every quest, and autoIndex would run it on a request path.
 *
 * Builds only that index, not the model's other declared ones: an environment's existing index can differ
 * from the schema, and the resulting conflict would fail the deploy. Idempotent: createIndex is a no-op
 * for an identical index that already exists.
 */
const migration: MigrationFile = {
  id: 20261120072518,
  name: 'ensure quest session pending action index',

  up: async () => {
    const spec = Quest.schema.indexes().find(([, options]) => options?.name === 'sessionId_pendingActionTs');
    if (!spec)
      throw new Error('Quest declares no sessionId_pendingActionTs index; this migration no longer matches its schema');
    // mongoose and the driver type index keys and options differently; the values are the same.
    type CreateIndexArgs = Parameters<typeof Quest.collection.createIndex>;
    await Quest.collection.createIndex(spec[0] as CreateIndexArgs[0], spec[1] as CreateIndexArgs[1]);
  },

  down: async () => {
    // Indexes are additive; dropping this one would put the count on a collection scan.
  },
};

export default migration;
