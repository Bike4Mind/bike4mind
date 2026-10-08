import { GenerationJobModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Build the GenerationJob { requestedBy, _id } index behind GET /api/v1/video-generations.
 *
 * Backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), whose own test requires it to stay
 * the highest id on disk; same reason as EnsureGenerationJobIndexes (20260921235991).
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921235992,
  name: 'ensure generation job requester index',

  up: async () => {
    await GenerationJobModel.createIndexes();
  },

  down: async () => {
    // Read-path index only; removal would be a deliberate forward migration.
  },
};

export default migration;
