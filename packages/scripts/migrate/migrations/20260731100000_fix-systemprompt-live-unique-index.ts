import { safeDropIndex, SystemPrompt } from '@bike4mind/database';
import { type MigrationFile } from './index';

export interface LiveSystemPromptRow {
  _id: unknown;
  promptId: string;
  updatedAt?: Date | null;
  createdAt?: Date | null;
}

/**
 * Of the live rows sharing a promptId, keep the most recently touched one and return the `_id`s of
 * the rest (the ones to soft-delete). Ties resolve to whichever row came first in `rows`; rows with
 * a unique promptId are never returned.
 */
export function selectSupersededDuplicates(rows: LiveSystemPromptRow[]): unknown[] {
  const byPromptId = new Map<string, LiveSystemPromptRow[]>();
  for (const row of rows) {
    const group = byPromptId.get(row.promptId);
    if (group) group.push(row);
    else byPromptId.set(row.promptId, [row]);
  }

  const stamp = (row: LiveSystemPromptRow) => (row.updatedAt ?? row.createdAt ?? new Date(0)).getTime();

  const superseded: unknown[] = [];
  for (const group of byPromptId.values()) {
    if (group.length < 2) continue;
    const winner = group.reduce((best, row) => (stamp(row) > stamp(best) ? row : best));
    superseded.push(...group.filter(row => row !== winner).map(row => row._id));
  }
  return superseded;
}

const migration: MigrationFile = {
  id: 20260731100000,
  name: 'rebuild systemprompt promptId unique index on live rows (partial filter was inert)',

  up: async () => {
    // `promptId_1` was declared with `partialFilterExpression: { deletedAt: { $exists: false } }`,
    // but softDeletePlugin gives every document `deletedAt: null` by default - so the filter
    // matched no documents and the unique constraint never enforced anything. Duplicates can
    // therefore already exist; dedupe before rebuilding or the index build fails with E11000.
    // Raw collection throughout: the plugin's find/update hooks rewrite these filters.
    const rows = (await SystemPrompt.collection
      .find({ deletedAt: null }, { projection: { promptId: 1, updatedAt: 1, createdAt: 1 } })
      .toArray()) as unknown as LiveSystemPromptRow[];

    const superseded = selectSupersededDuplicates(rows);
    if (superseded.length > 0) {
      // Soft-delete rather than drop: the losing rows stay recoverable, and their version history
      // (SystemPromptHistory, keyed by promptId) is untouched either way.
      const result = await SystemPrompt.collection.updateMany(
        { _id: { $in: superseded } as never },
        { $set: { deletedAt: new Date() } }
      );
      console.log(`Soft-deleted ${result.modifiedCount} duplicate live system prompt(s)`);
    }

    // Same name as the schema declaration: a differently-named index on the same key pattern
    // would collide with autoIndex (IndexKeySpecsConflict).
    await safeDropIndex(SystemPrompt.collection, 'promptId_1');
    await SystemPrompt.collection.createIndex(
      { promptId: 1 },
      { unique: true, partialFilterExpression: { deletedAt: null }, name: 'promptId_1' }
    );
    console.log('Rebuilt promptId_1 as a live-only partial unique index');
  },

  down: async () => {
    // Intentional no-op. Restoring the `$exists: false` filter would just reinstate an index that
    // enforces nothing, and the dedupe above is not meaningfully reversible. Same rationale as
    // 20260619000000's down().
  },
};

export default migration;
