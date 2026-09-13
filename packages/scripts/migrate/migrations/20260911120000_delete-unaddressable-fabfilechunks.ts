import { FabFile, FabFileChunk, mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Delete `fabfilechunks` rows whose `fabFileId` is not an ObjectId string.
 *
 * `fabFileId` is a plain String with a `ref`, so a value that cannot address a FabFile by `_id`
 * stores clean. A batch of rows holding a whole serialized FabFile document got in that way around
 * 2024-10-03; the code responsible is long gone. Every reader reaches a chunk through `fabFileId`
 * (`findVectorsByFabFileIds`, `findByFabFileId`, `$vectorSearch`'s `$in` filter), so such a row is
 * invisible to retrieval, and `deleteManyByFabFileId` matches the same field, so ordinary file
 * deletion never reaped it either. It is unreachable dead weight in both directions.
 *
 * A registered migration rather than a hand-run script because a hand-run script does not get run.
 * The schema now carries a format validator on the field (FabFileChunkSchema, packages/database),
 * so this is a one-time sweep, not a recurring one.
 *
 * SHAPE, not a hardcoded id list - the affected set differs per environment. Two gates, and a row
 * has to fail both to be deleted:
 *
 *  1. `fabFileId` is a string that is not 24 hex characters, so it cannot address a row by `_id`.
 *     Deliberately scoped to strings: a row with the field absent or of another type is a different
 *     corruption with a different safety argument, and is left for whoever finds it.
 *  2. No ObjectId recoverable FROM that string resolves to a fabfile. The serialized documents
 *     embed the original file's id, so every 24-hex run in the value is looked up; if any hits a
 *     fabfile row - live OR soft-deleted - the chunk is KEPT and reported, because then someone
 *     could still re-associate it and a delete here would not be recoverable.
 *
 * Dry-run by setting DELETE_UNADDRESSABLE_CHUNKS_DRY_RUN=1, which reports the counts and writes
 * nothing. The default is to execute: the migrator runs `up()` unattended at deploy.
 *
 * NOT REVERSIBLE. `down()` is a no-op - the rows are gone and nothing reconstructs them. That is
 * the whole reason gate 2 errs towards keeping a row.
 */

/** Chunks read per page. Only `_id` and `fabFileId` are projected, but an offending value is a
 *  whole serialized document (~425 characters observed), so the page stays modest. */
const PAGE_SIZE = 200;

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Every 24-hex run in the value, deliberately generous: a false candidate only keeps a row. */
const EMBEDDED_OBJECT_ID = /[0-9a-fA-F]{24}/g;

const KEPT_ID_LOG_CAP = 50;

const migration: MigrationFile = {
  id: 20260911120000,
  name: 'delete-unaddressable-fabfilechunks',

  up: async () => {
    const dryRun = process.env.DELETE_UNADDRESSABLE_CHUNKS_DRY_RUN === '1';
    // Raw driver collections, not the models: the chunk values this matches are exactly the ones
    // the schema now rejects, and FabFile's soft-delete middleware would hide the very rows gate 2
    // needs to see.
    const chunks = FabFileChunk.collection;
    const fabFiles = FabFile.collection;

    // Keyset paging on `_id` rather than a live cursor: the loop deletes out from under itself, and
    // a kept row must not be revisited forever.
    let afterId: mongoose.Types.ObjectId | undefined;
    let deleted = 0;
    const keptIds: string[] = [];

    for (;;) {
      const page = await chunks
        .find(
          {
            $and: [
              { fabFileId: { $type: 'string' } },
              { fabFileId: { $not: OBJECT_ID_HEX } },
              ...(afterId ? [{ _id: { $gt: afterId } }] : []),
            ],
          },
          { projection: { _id: 1, fabFileId: 1 }, sort: { _id: 1 }, limit: PAGE_SIZE }
        )
        .toArray();
      if (page.length === 0) break;
      afterId = page[page.length - 1]._id as mongoose.Types.ObjectId;

      const embeddedByRow = new Map(
        page.map(row => [String(row._id), [...String(row.fabFileId).matchAll(EMBEDDED_OBJECT_ID)].map(m => m[0])])
      );
      const candidateIds = new Set([...embeddedByRow.values()].flat());

      // One lookup per page over the union of candidates, including soft-deleted rows - a row whose
      // file is merely soft-deleted is still re-associable, so it is not this migration's to remove.
      const resolvable = new Set<string>();
      if (candidateIds.size > 0) {
        const found = await fabFiles
          .find(
            { _id: { $in: [...candidateIds].map(id => new mongoose.Types.ObjectId(id)) } },
            { projection: { _id: 1 } }
          )
          .toArray();
        for (const doc of found) resolvable.add(String(doc._id));
      }

      const deletable: mongoose.Types.ObjectId[] = [];
      for (const row of page) {
        const embedded = embeddedByRow.get(String(row._id)) ?? [];
        if (embedded.some(id => resolvable.has(id))) keptIds.push(String(row._id));
        else deletable.push(row._id as mongoose.Types.ObjectId);
      }

      if (deletable.length === 0) continue;
      if (dryRun) {
        deleted += deletable.length;
      } else {
        deleted += (await chunks.deleteMany({ _id: { $in: deletable } })).deletedCount;
      }
    }

    const prefix = dryRun ? '[dry-run] Would delete' : 'Deleted';
    console.log(`${prefix} ${deleted} unaddressable fabfilechunk row(s)`);
    if (keptIds.length > 0) {
      // These need a human: the value is unaddressable but its embedded id still names a real file,
      // so the chunk may be worth re-pointing rather than dropping.
      console.warn(
        `${keptIds.length} row(s) have an unaddressable fabFileId that still embeds a resolvable file id - kept for manual review`
      );
      console.warn(`   chunk ids: ${keptIds.slice(0, KEPT_ID_LOG_CAP).join(', ')}`);
      if (keptIds.length > KEPT_ID_LOG_CAP) {
        console.warn(`   ... and ${keptIds.length - KEPT_ID_LOG_CAP} more (capped at ${KEPT_ID_LOG_CAP})`);
      }
    }
  },

  down: async () => {
    // Deleted rows are not reconstructable. See the docblock.
  },
};

export default migration;
