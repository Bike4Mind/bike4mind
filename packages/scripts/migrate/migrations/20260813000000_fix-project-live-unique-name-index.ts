import { Project, safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

export interface LiveProjectRow {
  _id: unknown;
  userId: string;
  name: string;
  updatedAt?: Date | null;
  createdAt?: Date | null;
}

/**
 * Of the live rows sharing a (userId, name), keep the most recently touched one and return the
 * `_id`s of the rest (the ones to soft-delete). Ties resolve to whichever row came first in `rows`;
 * a (userId, name) with a single live row is never returned.
 */
export function selectSupersededDuplicates(rows: LiveProjectRow[]): unknown[] {
  const byKey = new Map<string, LiveProjectRow[]>();
  for (const row of rows) {
    // JSON-encoded pair as the map key: unambiguous, so (userId, name) groups never collide.
    const key = JSON.stringify([row.userId, row.name]);
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  const stamp = (row: LiveProjectRow) => (row.updatedAt ?? row.createdAt ?? new Date(0)).getTime();

  const superseded: unknown[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const winner = group.reduce((best, row) => (stamp(row) > stamp(best) ? row : best));
    superseded.push(...group.filter(row => row !== winner).map(row => row._id));
  }
  return superseded;
}

const migration: MigrationFile = {
  id: 20260813000000,
  name: 'rebuild project userId+name unique index on live rows (partial filter was inert)',

  up: async () => {
    // `userId_1_name_1` was declared unique with `partialFilterExpression: { deletedAt: { $exists: false } }`,
    // which Mongo rejects in a partial filter - so the index never built and per-user name uniqueness
    // (surfaced to users as "Project <name> already exists", pages/api/projects/index.ts) was never
    // enforced. Duplicate live rows can therefore already exist; dedupe before rebuilding or the index
    // build fails with E11000. Raw collection throughout: the softDeletePlugin hooks rewrite these filters.
    // Loads all live rows into memory (precedent-consistent with the SystemPrompt migration); fine for a
    // one-shot migration, but if `projects` grows huge a $group-for-duplicates pass would bound it.
    const rows = (await Project.collection
      .find({ deletedAt: null }, { projection: { userId: 1, name: 1, updatedAt: 1, createdAt: 1 } })
      .toArray()) as unknown as LiveProjectRow[];

    const superseded = selectSupersededDuplicates(rows);
    if (superseded.length > 0) {
      // Soft-delete rather than drop: the losing rows stay recoverable.
      const result = await Project.collection.updateMany(
        { _id: { $in: superseded } as never },
        { $set: { deletedAt: new Date() } }
      );
      console.log(`Soft-deleted ${result.modifiedCount} duplicate live project(s)`);
    }

    // Same name as the schema declaration: a differently-named index on the same key pattern
    // would collide with autoIndex (IndexKeySpecsConflict). The drop->create window is briefly
    // index-less; if a duplicate live pair is inserted in between, createIndex throws and the
    // migration fails without recording (migrationManager records only on success), so the next
    // run simply re-dedupes and recreates. safeDropIndex also tolerates an already-absent index.
    await safeDropIndex(Project.collection, 'userId_1_name_1');
    await Project.collection.createIndex(
      { userId: 1, name: 1 },
      { unique: true, partialFilterExpression: { deletedAt: null }, name: 'userId_1_name_1' }
    );
    console.log('Rebuilt userId_1_name_1 as a live-only partial unique index');
  },

  down: async () => {
    // Intentional no-op. Restoring the `$exists: false` filter would just reinstate an index that
    // enforces nothing, and the dedupe above is not meaningfully reversible.
  },
};

export default migration;
