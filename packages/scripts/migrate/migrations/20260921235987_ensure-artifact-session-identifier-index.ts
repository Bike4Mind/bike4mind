import { Artifact } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the `{ sessionId, identifier }` index exists on artifacts: chat persistence looks up the
 * session's row for a re-emitted `<artifact identifier=...>` to version it.
 *
 * Migration rather than autoIndex for the same reason as 20260921235993: prod runs DocumentDB, where
 * an index build takes a foreground collection lock. Idempotent: createIndex is a no-op when the
 * index already exists. Id backdated below 20260922000001, whose test asserts it stays highest.
 */
const migration: MigrationFile = {
  id: 20260921235987,
  name: 'ensure artifact session identifier index',

  up: async () => {
    await Artifact.collection.createIndex({ sessionId: 1, identifier: 1 });
  },

  down: async () => {
    // Indexes are additive. Removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
