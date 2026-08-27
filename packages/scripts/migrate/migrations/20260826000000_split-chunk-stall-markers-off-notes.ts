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
 * Keyed on the literal strings the writers used (CHUNK_STALL_NOTICES / NO_EXTRACTABLE_TEXT_NOTICE in
 * b4m-core/common/src/constants/chunking.ts). Inlined rather than imported so a later reword of the
 * owner-facing prose cannot silently change what this migration matched - a migration's predicate is
 * a historical fact.
 *
 * Two arms per marker, and the split is the whole safety argument:
 *
 *  - EXACT match on a known marker string: the field is provably not owner text (only the pipeline
 *    ever wrote it verbatim), so the row is derived AND `notes` is unset. Leaving it would keep the
 *    marker visible as if the owner had written it.
 *  - PREFIX match that is not one of those strings: the row starts with a marker and continues into
 *    something else, which is reachable - the Edit-notes modal prefills the textarea with whatever is
 *    in `notes`, marker included, and PUTs it back unstripped, so an owner can type below one. Those
 *    rows are derived so they keep grading the same way (a reader parses prose nowhere any more), but
 *    `notes` is LEFT ALONE. Destroying owner text is the exact harm this migration exists to undo, so
 *    it is never worth a tidier row.
 *
 * Idempotent: the exact arms match nothing on a second pass (the prose is gone), and the prefix arms
 * are guarded on the derived field still being unset.
 *
 * DEPLOY WINDOW, accepted deliberately. Only `web` waits on the migrator (infra/web.ts), so an OLD
 * queue handler can still write a marker into `notes` after this has run, and nothing derives it
 * afterwards. The zero-chunk half self-heals (the rescue sweep re-enqueues once and the new handler
 * re-stamps); the stall half does not, and such a row reads as unstalled until someone reprocesses
 * it. The conjunction needed is narrow - the convergence kill switch active DURING a deploy - and
 * the remedy if it ever happens is a second dated migration running these same arms after cutover.
 * Gating the queue stacks on the migrator would not close it: the old handlers keep serving until
 * their own deploy either way.
 */

/** The markers are fixed literals, but they contain regex metacharacters ('(', ')', '.'). */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VECTORIZE_PAUSED_NOTE = 'Indexing paused by the data-lake convergence kill switch - reprocess to complete.';

const RECHUNK_PAUSED_NOTE =
  'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
  'rebuilt when convergence resumes.';

// Every wording the zero-chunk phrase has ever had in this repo, enumerated from history
// (`git log --all -p -S"No extractable text" -- '*.ts'`). Only the first two were ever written by a
// handler; the rest have only ever been test fixtures, and are listed because an exact match on a
// string nothing wrote costs nothing while a missed wording would strand a row.
const NO_EXTRACTABLE_TEXT_NOTES = [
  'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).',
  'No extractable text \u2014 re-process or re-upload (e.g. image-only or unsupported content).',
  'No extractable text',
  'No extractable text: scanned image',
  'No extractable text found in this file',
];

// `^` anchored, so a note that merely mentions the phrase mid-sentence is the owner's text and is
// not swept. Rows matching this but not NO_EXTRACTABLE_TEXT_NOTES keep their `notes` - see the
// docblock's two-arm split.
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
      const exact = await fabFiles.updateMany(
        { notes: note },
        { $set: { chunkStallReason: reason }, $unset: { notes: '' } }
      );
      console.log(`✅ Derived chunkStallReason='${reason}' on ${exact.modifiedCount} FabFile rows`);

      // `chunkStallReason: null` (which matches an absent field) is what keeps this arm idempotent:
      // these rows keep the prose, so without it a second pass would match them again.
      const appended = await fabFiles.updateMany(
        { notes: { $regex: `^${escapeRegExp(note)}` }, chunkStallReason: null },
        { $set: { chunkStallReason: reason } }
      );
      if (appended.modifiedCount > 0) {
        console.log(
          `   ${appended.modifiedCount} row(s) had owner text appended to the '${reason}' marker - ` +
            'derived, notes left intact for a human to trim'
        );
      }
    }

    // No timestamp survives in the old data - the note said nothing about when chunking produced
    // zero. `updatedAt` is the closest honest stand-in (the flag write was the last thing the handler
    // did on that path); rows without one fall back to the migration's own clock, since the field is
    // read only as a boolean by `buildFabFileChunkScanFilter` and the reprocess reset.
    const zeroChunkCursor = fabFiles.find(
      { notes: NO_EXTRACTABLE_TEXT_NOTE_PREFIX, noExtractableTextAt: null },
      { projection: { _id: 1, updatedAt: 1, notes: 1 } }
    );
    let freed = 0;
    let kept = 0;
    while (await zeroChunkCursor.hasNext()) {
      const doc = await zeroChunkCursor.next();
      if (!doc) break;
      const isWholeMarker = NO_EXTRACTABLE_TEXT_NOTES.includes(doc.notes);
      await fabFiles.updateOne(
        { _id: doc._id },
        {
          $set: { noExtractableTextAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date() },
          ...(isWholeMarker ? { $unset: { notes: '' } } : {}),
        }
      );
      if (isWholeMarker) freed++;
      else kept++;
    }
    console.log(`✅ Derived noExtractableTextAt on ${freed + kept} FabFile rows`);
    if (kept > 0) {
      console.log(
        `   ${kept} of those had owner text appended to the marker - derived, notes left intact for a human to trim`
      );
    }
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
