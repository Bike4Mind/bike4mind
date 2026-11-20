import { PublishedArtifact } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the partial unique index that allows one live v1-published page per artifact and owner
 * (`ownerId_1_v1ArtifactId_1`). It only covers rows carrying `v1ArtifactId`, which only the v1 publish endpoint
 * writes, so no existing row can violate it and the build cannot fail on legacy duplicates. Builds only this
 * index, so an unrelated index conflict cannot fail it. Idempotent: createIndex is a no-op when an identical index
 * exists. Key, name and options must stay in sync with the schema declaration in PublishedArtifactModel.
 */
const migration: MigrationFile = {
  id: 20261119120620,
  name: 'ensure published artifact v1 unique index',

  up: async () => {
    await PublishedArtifact.collection.createIndex(
      { ownerId: 1, v1ArtifactId: 1 },
      {
        name: 'ownerId_1_v1ArtifactId_1',
        unique: true,
        partialFilterExpression: { v1ArtifactId: { $type: 'string' }, deletedAt: null },
      }
    );
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
