import { GenerationJobModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the GenerationJob collection's indexes.
 *
 * Built here rather than by autoIndex: `mongo.ts` only awaits `connect`, so an autoIndex build is
 * fire-and-forget and fails silently, and DocumentDB takes a foreground lock for the build.
 *
 * The id is backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), whose own
 * test requires it to stay the highest id on disk.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235991,
  name: 'ensure generation job indexes',

  up: async () => {
    await GenerationJobModel.createIndexes();
  },

  down: async () => {
    // Read/claim-path indexes only; removal would be a deliberate forward migration.
  },
};

export default migration;
