import { Memento } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure `{ userId: 1, _id: 1 }` exists on mementos.
 *
 * Memento retrieval pages a user's mementos with a keyset cursor (`userId` equality + sort on
 * `_id`) so scoring no longer holds every memento - each carrying an embedding and its full
 * content - in memory at once. None of the pre-existing memento indexes can serve a sort on
 * `_id`, so without this the planner sorts the user's whole memento set once per page, which is
 * more expensive than the unbounded read the paging replaced.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist, and it builds every index
 * the schema declares (the three pre-existing ones included, harmlessly). `down` is one-way -
 * indexes are additive and dropping this one would regress the walk.
 */
const migration: MigrationFile = {
  id: 20260804000000,
  name: 'ensure memento keyset index',

  up: async () => {
    await Memento.createIndexes();
  },

  down: async () => {
    // Removal, if ever wanted, should be a deliberate forward migration.
  },
};

export default migration;
