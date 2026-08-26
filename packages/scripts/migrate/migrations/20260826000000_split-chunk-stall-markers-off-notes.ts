import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Move the three machine-written pipeline markers off `FabFile.notes` and onto their own fields.
 *
 * `notes` is documented as the owner's own note, but the chunk/vector pipeline wrote two other facts
 * into the same string - the convergence kill-switch stall markers and the zero-chunk "no extractable
 * text" flag - so every writer clobbered the others, and `resetChunkStateByIds`' `notes: ''` deleted
 * whatever the owner had typed on every rebuild wave. The readers now key on `chunkStallReason` and
 * `noExtractableTextAt`; this derives both for existing rows and frees the prose.
 *
 * Matched on the EXACT strings the writers used (CHUNK_STALL_NOTICES / NO_EXTRACTABLE_TEXT_NOTICE in
 * b4m-core/common/src/constants/chunking.ts). Inlined rather than imported so a later reword of the
 * owner-facing prose cannot silently change what this migration matched - a migration's predicate is
 * a historical fact.
 *
 * `notes` is UNSET on a matched row rather than left in place: leaving it would keep the marker
 * visible as if the owner had written it, and it is provably not owner text - only the pipeline ever
 * wrote these exact strings. Rows whose note merely CONTAINS one of them are not matched; the writers
 * always assigned the whole field.
 *
 * Idempotent: re-running matches nothing, because the first pass removed the strings it keys on.
 */

const VECTORIZE_PAUSED_NOTE = 'Indexing paused by the data-lake convergence kill switch - reprocess to complete.';

const RECHUNK_PAUSED_NOTE =
  'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
  'rebuilt when convergence resumes.';

// Prefix, not an exact string: the zero-chunk writer's wording changed once while it lived in
// `notes`, and every variant began here. `^` anchored so an owner's note that merely mentions the
// phrase is not swept.
const NO_EXTRACTABLE_TEXT_NOTE_PREFIX = /^No extractable text/;

const migration: MigrationFile = {
  id: 20260826000000,
  name: 'split-chunk-stall-markers-off-notes',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    const fabFiles = db.collection('fabfiles');

    for (const [reason, note] of [
      ['vectorizePaused', VECTORIZE_PAUSED_NOTE],
      ['rechunkPaused', RECHUNK_PAUSED_NOTE],
    ] as const) {
      const result = await fabFiles.updateMany(
        { notes: note },
        { $set: { chunkStallReason: reason }, $unset: { notes: '' } }
      );
      console.log(`✅ Derived chunkStallReason='${reason}' on ${result.modifiedCount} FabFile rows`);
    }

    // No timestamp survives in the old data - the note said nothing about when chunking produced
    // zero. `updatedAt` is the closest honest stand-in (the flag write was the last thing the handler
    // did on that path); rows without one fall back to the migration's own clock, since the field is
    // read only as a boolean by `buildFabFileChunkScanFilter` and the reprocess reset.
    const zeroChunkCursor = fabFiles.find(
      { notes: NO_EXTRACTABLE_TEXT_NOTE_PREFIX },
      { projection: { _id: 1, updatedAt: 1 } }
    );
    let zeroChunkCount = 0;
    while (await zeroChunkCursor.hasNext()) {
      const doc = await zeroChunkCursor.next();
      if (!doc) break;
      await fabFiles.updateOne(
        { _id: doc._id },
        {
          $set: { noExtractableTextAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date() },
          $unset: { notes: '' },
        }
      );
      zeroChunkCount++;
    }
    console.log(`✅ Derived noExtractableTextAt on ${zeroChunkCount} FabFile rows`);
  },

  down: async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    const fabFiles = db.collection('fabfiles');

    // Restores the prose so the pre-migration readers (which parse `notes`) grade these rows the same
    // way again, then drops the new fields. A row whose owner has typed a note SINCE the up-migration
    // is left alone on the `notes` half - overwriting real owner text to reconstruct a marker is the
    // exact harm this migration exists to undo - so its marker survives only in the dropped field.
    // Such a row grades as unstalled after a rollback, which is the same reading it had before the
    // marker was ever written.
    for (const [reason, note] of [
      ['vectorizePaused', VECTORIZE_PAUSED_NOTE],
      ['rechunkPaused', RECHUNK_PAUSED_NOTE],
    ] as const) {
      const result = await fabFiles.updateMany(
        { chunkStallReason: reason, $or: [{ notes: { $exists: false } }, { notes: '' }] },
        { $set: { notes: note } }
      );
      console.log(`   Restored ${result.modifiedCount} '${reason}' markers into notes`);
    }

    const restoredZeroChunk = await fabFiles.updateMany(
      { noExtractableTextAt: { $ne: null }, $or: [{ notes: { $exists: false } }, { notes: '' }] },
      { $set: { notes: 'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).' } }
    );
    console.log(`   Restored ${restoredZeroChunk.modifiedCount} no-extractable-text markers into notes`);

    const cleared = await fabFiles.updateMany(
      { $or: [{ chunkStallReason: { $exists: true } }, { noExtractableTextAt: { $exists: true } }] },
      { $unset: { chunkStallReason: '', noExtractableTextAt: '' } }
    );
    console.log(`Removed the split marker fields from ${cleared.modifiedCount} FabFile rows`);
  },
};

export default migration;
