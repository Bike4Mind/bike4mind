import { Migration } from '@bike4mind/database';
import { type MigrationFile } from './index';

type DuplicateMigrationId = { _id: number; count: number; names: string[] };

/** Ids recorded more than once in the applied-migrations collection, lowest first. */
export async function findDuplicateMigrationIds(): Promise<DuplicateMigrationId[]> {
  return Migration.aggregate<DuplicateMigrationId>([
    { $group: { _id: '$id', count: { $sum: 1 }, names: { $addToSet: '$name' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ]);
}

const migration: MigrationFile = {
  id: 20261127043214,
  name: 'ensure migration id unique index',
  rerunSafe: 'The duplicate check only reads, and createIndexes is a no-op once the index exists.',
  // Nothing depends on this index, so a held run should not stop the migrations after it.
  failClosed: true,

  up: async () => {
    const duplicates = await findDuplicateMigrationIds();
    if (duplicates.length > 0) {
      const listed = duplicates.map(d => `${d._id} x${d.count} (${d.names.join(', ')})`).join('; ');
      throw new Error(
        `Cannot build the unique index on migrations.id: ${duplicates.length} migration id(s) are recorded ` +
          `more than once: ${listed}. Nothing was changed. Resolve them as described under ` +
          `"Duplicate migration records" in packages/scripts/migrate/README.md, then redeploy.`
      );
    }
    await Migration.createIndexes();
  },

  // One-way: the index only rejects duplicate records, which the runner never meant to write.
  down: async () => {},
};

export default migration;
