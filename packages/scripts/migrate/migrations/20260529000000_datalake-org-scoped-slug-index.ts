import { DataLakeModel, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Move data-lake slug uniqueness from a global `slug_1` unique index to a per-org
 * compound `{ organizationId, slug }` unique index.
 *
 * The legacy global `slug_1` index keeps enforcing GLOBAL slug uniqueness, which
 * defeats the new org-scoped model (two orgs may share a slug). Mongoose never drops
 * removed indexes, so this migration drops it explicitly. The new compound index is
 * auto-created on app start (autoIndex) as declared in DataLakeModel.
 *
 * Safety: existing rows had globally-unique slugs under `slug_1`, so every
 * (organizationId, slug) pair is already unique and the new compound build cannot
 * fail on legacy data. We still pre-flight for duplicate (organizationId, slug)
 * groups and fail loudly with the offending ids rather than risk a silent broken
 * unique build.
 */
const migration: MigrationFile = {
  id: 20260529000000,
  name: 'datalake org-scoped slug index',

  up: async () => {
    // Pre-flight: detect any duplicate (organizationId, slug) groups before touching indexes.
    const dupes = await DataLakeModel.aggregate<{
      _id: { organizationId: string | null; slug: string };
      ids: string[];
    }>([
      { $group: { _id: { organizationId: '$organizationId', slug: '$slug' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    if (dupes.length > 0) {
      const detail = dupes
        .map(d => `org=${d._id.organizationId ?? '<none>'} slug=${d._id.slug} ids=[${d.ids.join(', ')}]`)
        .join('; ');
      throw new Error(
        `Cannot build unique {organizationId, slug} index — duplicate groups exist. Resolve these first: ${detail}`
      );
    }

    // Drop the legacy global-unique slug index. The per-org compound unique index is
    // declared in DataLakeModel and auto-created on app start.
    await safeDropIndex(DataLakeModel.collection, 'slug_1');
  },

  down: async () => {
    // Recreating a global-unique slug index could fail if two orgs now share a slug,
    // which is the whole point of this migration - so the down is intentionally a no-op.
  },
};

export default migration;
