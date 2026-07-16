import { ImageGenerationTemplate } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the ImageGenerationTemplate catalog indexes exist. Idempotent -
 * createIndexes is a no-op for already-built indexes (they're also declared on
 * the model for autoIndex). No seed data: templates are personal and authored
 * at runtime via the image-templates API.
 */
const migration: MigrationFile = {
  id: 20260715000000,
  name: 'image-generation-template indexes',

  up: async () => {
    await ImageGenerationTemplate.createIndexes();
  },

  down: async () => {
    // Indexes are additive; dropping them risks a write-performance regression.
    // Removal, if ever needed, should be a deliberate forward migration.
  },
};

export default migration;
