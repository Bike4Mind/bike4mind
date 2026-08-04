import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: drop the stored `fileCount` counter from file-tag documents.
 *
 * Tag counts are derived per read by tagService/listFileTags, so the column has no readers left.
 * It never had reliable writers either: only the toggle path and the file-delete routes maintained
 * it, while the `$pull` removal path, a whole-array tags replace on PUT /api/files/[id], and tags
 * set at file creation all left it behind, so every long-lived tag drifted.
 *
 * This is not housekeeping. Mongoose keeps a stored path it has no schema entry for and `toJSON`
 * emits it, so until this runs, a tag read through any repository method still carries its drifted
 * number - and a caller that forwards a raw tag document (the PUT /api/files/tags/[id] response,
 * which the client merges into its tag-list cache) would pass that stale value to the UI.
 * listFileTags is unaffected either way, because it spreads its own derived count last.
 *
 * Goes through the raw collection rather than the model on purpose: mongoose strict mode strips
 * update paths that are absent from the schema, and `fileCount` was removed from FileTagSchema in
 * this same change - so a model-level `$unset` would be silently dropped and do nothing.
 *
 * Not scoped to the `file` discriminator: only file tags ever carried the key, and scoping would
 * strand it on a document whose `type` is missing or wrong.
 *
 * Idempotent: `$exists` (rather than a truthiness test, which would skip a legitimate `fileCount: 0`)
 * means a second run matches nothing.
 */
const migration: MigrationFile = {
  id: 20260804000000,
  name: 'drop-filetag-filecount',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const result = await db
      .collection('tags')
      .updateMany({ fileCount: { $exists: true } }, { $unset: { fileCount: '' } });

    console.log(`[drop-filetag-filecount] unset fileCount on ${result.modifiedCount} tag document(s)`);
  },

  // Irreversible on purpose. The values this removes were drifted - that is why the column was
  // dropped - so there is nothing faithful to restore. Writing a freshly recomputed count back
  // would re-create the unmaintained counter this change exists to delete, and the next write
  // through the model would strip it again anyway.
  down: async () => {},
};

export default migration;
