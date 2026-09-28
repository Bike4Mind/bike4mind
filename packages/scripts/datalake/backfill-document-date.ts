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
 * Selection: live, fully chunked, not mid-chunk, not rewritten since its last chunk pass, and
 * `documentDate` never written. Every content pass since #3048 writes the pair (null when nothing
 * was found), so an ABSENT field means the file predates the feature. That same predicate guards
 * the write, so a Reprocess that lands between the read and the write wins, and a rerun after a
 * partial failure picks up where it left off. A rewritten file is left for its next re-chunk.
 *
 * Unrecoverable by design: a Google Editors file ingested before #3048 has no pinned Drive
 * `createdTime`, and its stored bytes are an export rendition that cannot date it. It is written
 * as null (what a Reprocess would write) without downloading it, and counted separately. Recovering
 * those needs Drive's createdTime, which a Drive re-sync captures and this script does not fetch.
 *
 * A row whose bytes are gone (no filePath, or a deleted S3 object) is left untouched and listed
 * separately: nothing can date it, and counting it as a failure would fail every rerun.
 *
 * Dry-run by default: it still downloads and extracts, so the summary shows what would be written.
 * Pass --execute to write.
 *
 * Usage (needs DB + the fabFile bucket, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/backfill-document-date.ts --limit 50
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/backfill-document-date.ts --execute
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import type { Types } from 'mongoose';
import { OpenAIEmbeddingModel, type IFabFile } from '@bike4mind/common';
import { connectDB, FabFile } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { fabFilesService } from '@bike4mind/services';
import { S3Storage, SmartChunker } from '@bike4mind/fab-pipeline';

type Options = {
  execute: boolean;
  batchSize: number;
  limit?: number;
  fileIds: string[];
};

type CandidateFile = Pick<
  IFabFile,
  'filePath' | 'mimeType' | 'sourceType' | 'driveMd5Checksum' | 'documentDate' | 'documentDateSource'
> & { _id: Types.ObjectId };

type Outcome = 'dated' | 'undated' | 'editors-unrecoverable' | 'bytes-missing' | 'raced' | 'failed';

// Only sizes the chunks, which are thrown away; it has no bearing on which date is extracted.
const CHUNKER_MODEL = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;

const ELIGIBLE = {
  documentDate: { $exists: false },
  // The date must describe the chunks being SERVED. A content rewrite replaces the stored bytes but
  // keeps the old chunks until the next re-chunk, so dating those bytes would date text retrieval
  // is not returning. FAB_FILE_CONTENT_REWRITE_PATCH (and the reprocess reset) mark exactly that
  // state with an explicit null here, which a completed chunk pass never writes; absent is fine.
  chunkedCharCount: { $not: { $type: 'null' } },
};

function candidateFilter(opts: Options, afterId: Types.ObjectId | undefined) {
  const idClause = {
    ...(afterId ? { $gt: afterId } : {}),
    ...(opts.fileIds.length > 0 ? { $in: opts.fileIds } : {}),
  };
  return {
    ...ELIGIBLE,
    deletedAt: null,
    chunked: true,
    // A file mid-chunk is about to get its date from that pass; leave it to it.
    chunkClaimedAt: null,
    ...(Object.keys(idClause).length > 0 ? { _id: idClause } : {}),
  };
}

async function processFile(
  file: CandidateFile,
  opts: Options,
  deps: { chunker: SmartChunker; storage: S3Storage }
): Promise<Outcome> {
  const pinned = fabFilesService.resolveDocumentDateWithoutContent(file);
  const isEditorsFile = pinned !== undefined;

  let resolved = pinned;
  if (!resolved) {
    const content = await readStoredBytes(file, deps.storage);
    if (!content) return 'bytes-missing';
    await deps.chunker.chunkFile(content, file.mimeType);
    resolved = fabFilesService.resolveDocumentDate(file, deps.chunker.getDocumentDate());
  }

  if (opts.execute) {
    // Native driver, not Model.updateOne: FabFileSchema's timestamps would otherwise bump updatedAt,
    // and a metadata backfill must not make every file in the corpus look freshly modified.
    const { matchedCount } = await FabFile.collection.updateOne(
      { _id: file._id, deletedAt: null, ...ELIGIBLE },
      { $set: resolved }
    );
    if (matchedCount === 0) return 'raced';
  }

  if (isEditorsFile) return 'editors-unrecoverable';
  return resolved.documentDate ? 'dated' : 'undated';
}

/**
 * The file's stored bytes, or `undefined` when the row points at nothing (no filePath, or an S3 key
 * that no longer exists). Those are permanent data problems no content pass can date, so they are
 * reported and left untouched rather than counted as failures that would fail every rerun.
 */
async function readStoredBytes(file: CandidateFile, storage: S3Storage): Promise<Buffer | undefined> {
  if (!file.filePath) return undefined;
  try {
    return await storage.getContentAsBuffer(file.filePath);
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
    throw error;
  }
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}), mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);

  const storage = new S3Storage(Resource.fabFileBucket.name);
  // The chunker's info/warn lines are about chunk sizing, which this script discards; errors still surface.
  const chunker = new SmartChunker(CHUNKER_MODEL, storage, new Logger({ minLevel: 'error' }));

  const counts: Record<Outcome, number> = {
    dated: 0,
    undated: 0,
    'editors-unrecoverable': 0,
    'bytes-missing': 0,
    raced: 0,
    failed: 0,
  };
  const failures: string[] = [];
  const missingBytes: string[] = [];
  let processed = 0;
  let afterId: Types.ObjectId | undefined;

  while (opts.limit === undefined || processed < opts.limit) {
    const pageSize = opts.limit === undefined ? opts.batchSize : Math.min(opts.batchSize, opts.limit - processed);
    const page = await FabFile.find(candidateFilter(opts, afterId))
      .select('_id filePath mimeType sourceType driveMd5Checksum documentDate documentDateSource')
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean<CandidateFile[]>();
    if (page.length === 0) break;
    // The cursor, not the shrinking candidate set, is what terminates a DRY-RUN pass (nothing gets
    // written, so the same page would repeat forever without it).
    afterId = page[page.length - 1]._id;

    for (const file of page) {
      try {
        const outcome = await processFile(file, opts, { chunker, storage });
        counts[outcome]++;
        if (outcome === 'bytes-missing') missingBytes.push(file._id.toString());
      } catch (error) {
        // One unreadable file must not abort a corpus-wide sweep; it is left undated, so a rerun
        // retries it, and main() exits non-zero so the failure is not mistaken for a clean run.
        counts.failed++;
        failures.push(file._id.toString());
        console.error(`  ${file._id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      processed++;
    }
    console.log(`  ${opts.execute ? 'processed' : '[dry-run] examined'} ${processed} file(s) so far`);
  }

  const verb = opts.execute ? 'Wrote' : 'Would write';
  console.log(
    `\n${verb} a date on ${counts.dated} file(s) and null on ${counts.undated} with no recoverable date; ` +
      `${counts['editors-unrecoverable']} unpinned Drive Editors file(s) set null without a download; ` +
      `${counts['bytes-missing']} skipped (stored bytes missing); ` +
      `${counts.raced} skipped (changed by a concurrent pass); ${counts.failed} failed.`
  );
  if (missingBytes.length > 0) console.log(`Missing-bytes file ids: ${missingBytes.join(', ')}`);
  if (failures.length > 0) console.log(`Failed file ids: ${failures.join(', ')}`);
  return failures.length > 0 ? 1 : 0;
}

const argv = yargs(hideBin(process.argv))
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('batch-size', { type: 'number', default: 100, describe: 'Files read per page' })
  .option('limit', { type: 'number', describe: 'Stop after this many files (default: all)' })
  .option('file-id', { type: 'string', array: true, default: [], describe: 'Restrict to these FabFile ids' })
  .check(checkedArgv => {
    // 0 means an unbounded page under Mongo's `.limit()` semantics, not an empty one.
    if (checkedArgv['batch-size'] < 1) throw new Error('--batch-size must be at least 1');
    if (checkedArgv.limit !== undefined && checkedArgv.limit < 1) throw new Error('--limit must be at least 1');
    return true;
  })
  .parseSync();

main({ execute: argv.execute, batchSize: argv['batch-size'], limit: argv.limit, fileIds: argv['file-id'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
