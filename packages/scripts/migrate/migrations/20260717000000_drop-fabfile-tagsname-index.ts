import { FabFile, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Drop the redundant single-field `{ 'tags.name': 1 }` index on the fabfiles collection.
 *
 * It is a strict leftmost prefix of the compound `{ 'tags.name': 1, archivedAt: 1, deletedAt: 1 }`
 * (kept), which serves every tag-access equality/anchored-regex query the single-field one did.
 * The schema declaration was removed in the same release; without that, autoIndex would recreate
 * this index on the next cold boot right after the drop, so the code + migration must ship together.
 *
 * `safeDropIndex` only swallows index-not-found, so this is a safe no-op where the index is already
 * absent. `down` is a no-op: recreating a redundant index is not worth the foreground build.
 */
const migration: MigrationFile = {
  id: 20260717000000,
  name: 'drop redundant fabfile tags.name index',

  up: async () => {
    await safeDropIndex(FabFile.collection, 'tags.name_1');
  },

  down: async () => {},
};

export default migration;
