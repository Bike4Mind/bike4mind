import { FabFile, Quest } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the quest `videos` index and the FabFile `sourceMetadata.generatedCopyKey` index exist.
 *
 * purgeDeletedNotebookMedia runs inside the notebook delete request and resolves generated keys
 * through `{ $or: [{ images }, { videos }] }` on quests and `generatedCopyKey` on files; both
 * must be index-backed. Migration rather than autoIndex for the reason given in
 * 20260909000000_ensure-quest-images-index. Idempotent: createIndexes skips existing indexes.
 */
const migration: MigrationFile = {
  id: 20260921240060,
  name: 'ensure generated media purge indexes',

  up: async () => {
    await Quest.createIndexes();
    await FabFile.createIndexes();
  },

  down: async () => {
    // Indexes are additive; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
