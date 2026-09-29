#!/usr/bin/env tsx
/**
 * One-time backfill for #3196: stamp `documentDate` / `documentDateSource` (#3048) onto FabFiles
 * that were chunked before the chunker captured a document's own vintage.
 *
 * Metadata-only, never a re-chunk: each file's stored bytes go through SmartChunker.chunkFile for
 * its date alone, the chunks it produces are discarded, and only the two date fields are written.
 * No passage is deleted and nothing is re-embedded, so every file stays searchable throughout and
 * the run costs no embedding spend. The winner is decided by resolveDocumentDate - the same rule
 * prepareFabFileChunks applies - so a backfilled file carries exactly what a Reprocess would give it.
 *
 * Selection (`ELIGIBLE` in documentDateBackfill.ts): live, fully chunked, not mid-chunk, has a stored
 * path, `chunkedCharCount` not nulled by a content rewrite, and `documentDate` never written. Every
 * content pass since #3048 writes the pair (null when nothing was found), so an ABSENT field means
 * the file predates the feature. That same predicate, plus the `serverTextHash`
 * read, guards the write, so a Reprocess that lands between the read and the write wins, and a rerun
 * retries only what is still undated. Files skipped for a lasting reason (missing bytes, stale chunks)
 * stay eligible, so a run that stops at --limit prints an --after-id to continue from instead of
 * re-examining them.
 *
 * The date must describe the chunks being SERVED. A content rewrite replaces the stored bytes but
 * keeps the old chunks until the next re-chunk, so dating the new bytes would date text retrieval is
 * not returning. Each file's re-extracted text is therefore checked against the `serverTextHash` its
 * last chunk commit recorded; a mismatch is left untouched and listed as stale for its next re-chunk.
 * A file last chunked before that hash existed (#1679) cannot be checked, so it is not selected at all
 * and only counted. --trust-unhashed dates those anyway, accepting that a legacy rewrite may be
 * misdated, and the summary reports how many were written that way.
 *
 * Unrecoverable by design: a Google Editors file ingested before #3048 has no pinned Drive
 * `createdTime`, and its stored bytes are an export rendition that cannot date it. It is written
 * as null (what a Reprocess would write) without downloading it, and counted separately. Recovering
 * those needs Drive's createdTime, which a Drive re-sync captures and this script does not fetch.
 *
 * A row whose S3 object is gone or empty is left untouched and listed separately: nothing can date it, and
 * counting it as a failure would fail every rerun. Rows with no filePath at all are never selected.
 *
 * Dry-run by default: it still downloads and extracts every file whose date depends on its bytes, so
 * the summary shows what would be written.
 * Pass --execute to write, and --trust-unhashed to include the files the hash cannot verify.
 *
 * Usage (needs DB + the fabFile bucket, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/backfill-document-date.ts --limit 50
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/backfill-document-date.ts --limit 50 --after-id <id>
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/backfill-document-date.ts --execute
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { OpenAIEmbeddingModel } from '@bike4mind/common';
import { connectDB } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { S3Storage, SmartChunker } from '@bike4mind/fab-pipeline';
import {
  checkOptions,
  exitCode,
  formatSummary,
  runBackfill,
  toBackfillOptions,
  type BackfillOptions,
} from './documentDateBackfill';

// Only sizes the chunks, which are thrown away; it has no bearing on which date is extracted.
const CHUNKER_MODEL = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;

async function main(opts: BackfillOptions): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}), mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);

  const storage = new S3Storage(Resource.fabFileBucket.name);
  // The chunker's info/warn lines are about chunk sizing, which this script discards; errors still surface.
  const chunker = new SmartChunker(CHUNKER_MODEL, storage, new Logger({ minLevel: 'error' }));

  const result = await runBackfill(opts, { chunker, storage, log: line => console.log(line) });
  console.log(`\n${formatSummary(result, opts.execute).join('\n')}`);
  return exitCode(result);
}

const argv = yargs(hideBin(process.argv))
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('batch-size', { type: 'number', default: 100, describe: 'Files read per page' })
  .option('limit', { type: 'number', describe: 'Stop after this many files (default: all)' })
  .option('trust-unhashed', {
    type: 'boolean',
    default: false,
    describe: 'Also date files chunked before serverTextHash existed, whose served chunks cannot be verified',
  })
  .option('file-id', { type: 'string', array: true, default: [], describe: 'Restrict to these FabFile ids' })
  .option('after-id', { type: 'string', describe: 'Only files with a greater _id (the id a --limit run prints)' })
  .check(checkedArgv => {
    const error = checkOptions(toBackfillOptions(checkedArgv));
    if (error) throw new Error(error);
    return true;
  })
  .parseSync();

main(toBackfillOptions(argv))
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
