import { GenerationJobModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the GenerationJob `payload.output.s3Key` index exists: purgeDeletedNotebookMedia resolves
 * generated keys to the jobs that produced them inside the delete request. Migration rather than
 * autoIndex for the reason given in 20260909000000_ensure-quest-images-index. Idempotent.
 */
const migration: MigrationFile = {
  id: 20260921240070,
  name: 'ensure generation job output key index',

  up: async () => {
    await GenerationJobModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
