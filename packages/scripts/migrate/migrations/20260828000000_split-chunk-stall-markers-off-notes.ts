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
 *  - EXACT match on a string a HANDLER ever wrote: the field is provably not owner text (only the
 *    pipeline ever produced it verbatim), so the row is derived AND `notes` is unset. Leaving it
 *    would keep the marker visible as if the owner had written it. The test that a wording belongs
 *    in this arm is that a handler wrote it, not that the phrase once appeared in the repo - a
 *    string only ever seen in a fixture is one a human could plausibly have typed.
 *  - ANY OTHER match: the row starts with a marker and continues into something else, or is a
 *    wording no handler wrote. Both are reachable - the Edit-notes modal prefills the textarea with
 *    whatever is in `notes`, marker included, and PUTs it back unstripped, so an owner can type
 *    below one or type the phrase outright. Those rows are derived so they keep grading the same way
 *    (a reader parses prose nowhere any more), but `notes` is LEFT ALONE. Destroying owner text is
 *    the exact harm this migration exists to undo, so it is never worth a tidier row.
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
 *
 * The READ side of that forward window is covered by `isChunkStalledFile`
 * (b4m-core/common/src/constants/chunking.ts) and its Mongo mirror in `buildFabFileSearchQuery`.
 * Those transitional arms read the legacy prose alongside the new field, so a retrieval path serving
 * AHEAD of this migration still withholds and NAMES a stalled file. They are deleted one release
 * after this has landed everywhere - see that docblock.
 *
 * ROLLING BACK PAST #2016 REQUIRES `migrate down`. Nothing reverts the data on its own
 * (`migratorInvocation` only ever runs `up`), and the transitional arms above do not help here: they
 * read prose this migration deleted, and the pre-#2016 code a rollback restores does not contain
 * them. A row left migrated reads as unstalled to every pre-#2016 reader - no `abandonedByKillSwitch`
 * health signal, a permanent "still indexing" from `partitionByIndexAvailability`, and no "Rebuild
 * passages" repair from `findConvergencePausedFilesByScope`. Run `down()` FIRST: the transitional
 * arms honor the prose it restores, so the still-new stack keeps working until it is gone. It is a
 * PARTIAL restore by design (see its comment): a row whose owner typed a note after `up()` keeps
 * that note and loses its marker with the dropped field, so audit those rather than assume `down()`
 * recovered every row.
 */

/** Applied to the two stall notes only; they are fixed literals but contain a regex metacharacter ('.'). */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VECTORIZE_PAUSED_NOTE = 'Indexing paused by the data-lake convergence kill switch - reprocess to complete.';

const RECHUNK_PAUSED_NOTE =
  'Re-chunking paused by the data-lake convergence kill switch - its passages were removed and are ' +
  'rebuilt when convergence resumes.';

// The only two zero-chunk wordings a handler ever wrote, from history
// (`git log --all -p -S"No extractable text" -- '*.ts'`). Deliberately NOT a list of every wording
// the phrase has had: the shorter historical forms ('No extractable text',
// 'No extractable text: scanned image', 'No extractable text found in this file') only ever existed
// as test fixtures and as a read-side prefix constant, so a row holding one exactly is evidence a
// HUMAN typed it - exactly the text this migration exists to protect. They still derive via the
// prefix below; they just keep their `notes`.
const NO_EXTRACTABLE_TEXT_HANDLER_NOTES = [
  'No extractable text - re-process or re-upload (e.g. image-only or unsupported content).',
  'No extractable text \u2014 re-process or re-upload (e.g. image-only or unsupported content).',
];

// `^` anchored, so a note that merely mentions the phrase mid-sentence is the owner's text and is
// not swept. Rows matching this but not NO_EXTRACTABLE_TEXT_HANDLER_NOTES keep their `notes` - see
// the docblock's two-arm split.
const NO_EXTRACTABLE_TEXT_NOTE_PREFIX = /^No extractable text/;

// A row that keeps its prose needs a human to trim the marker off the owner's note; a bare count in
// a deploy log gives them nothing to find it by. Capped so a pathological run cannot flood the log.
const TRIM_ID_LOG_CAP = 50;
const logIdsToTrim = (ids: string[]) => {
  console.log(`   ids to trim: ${ids.slice(0, TRIM_ID_LOG_CAP).join(', ')}`);
  if (ids.length > TRIM_ID_LOG_CAP) {
    console.log(`   ... and ${ids.length - TRIM_ID_LOG_CAP} more (capped at ${TRIM_ID_LOG_CAP})`);
  }
};

const migration: MigrationFile = {
  id: 20260828000000,
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
      const appendedFilter = { notes: { $regex: `^${escapeRegExp(note)}` }, chunkStallReason: null };
      // Collected BEFORE the update - the filter stops matching once the field is set. A kept row
      // renders the notice line and then the owner note whose first line is that same prose, so the
      // duplication is visible to the owner long before anyone finds it in a deploy log.
      const appendedIds = await fabFiles.find(appendedFilter, { projection: { _id: 1 } }).toArray();
      const appended = await fabFiles.updateMany(appendedFilter, { $set: { chunkStallReason: reason } });
      if (appended.modifiedCount > 0) {
        console.log(
          `   ${appended.modifiedCount} row(s) had owner text appended to the '${reason}' marker - ` +
            'derived, notes left intact for a human to trim'
        );
        logIdsToTrim(appendedIds.map(doc => String(doc._id)));
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
    const keptIds: string[] = [];
    while (await zeroChunkCursor.hasNext()) {
      const doc = await zeroChunkCursor.next();
      if (!doc) break;
      const isWholeMarker = NO_EXTRACTABLE_TEXT_HANDLER_NOTES.includes(doc.notes);
      await fabFiles.updateOne(
        { _id: doc._id },
        {
          $set: { noExtractableTextAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date() },
          ...(isWholeMarker ? { $unset: { notes: '' } } : {}),
        }
      );
      if (isWholeMarker) freed++;
      else keptIds.push(String(doc._id));
    }
    console.log(`✅ Derived noExtractableTextAt on ${freed + keptIds.length} FabFile rows`);
    if (keptIds.length > 0) {
      console.log(
        `   ${keptIds.length} of those had owner text appended to the marker - derived, notes left intact for a human to trim`
      );
      logIdsToTrim(keptIds);
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
