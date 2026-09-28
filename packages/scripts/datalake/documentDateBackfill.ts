/**
 * The metadata-only documentDate backfill (#3196), importable so it can be tested against a real
 * database. The CLI wrapper and the operator-facing rationale live in backfill-document-date.ts.
 */

import mongoose, { Types } from 'mongoose';
import type { IFabFile } from '@bike4mind/common';
import { FabFile } from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import type { ExtractedDocumentDate, S3Storage } from '@bike4mind/fab-pipeline';

export type BackfillOptions = {
  execute: boolean;
  batchSize: number;
  limit?: number;
  fileIds: string[];
};

/** The slice of SmartChunker the backfill uses: one extraction pass, read back for its date and text. */
export type DateExtractor = {
  chunkFile(content: Buffer, mimeType: string): Promise<unknown>;
  getDocumentDate(): ExtractedDocumentDate | undefined;
  getExtractedText(): string | undefined;
};

export type BackfillDeps = {
  chunker: DateExtractor;
  storage: Pick<S3Storage, 'getContentAsBuffer'>;
  log: (line: string) => void;
};

export type Outcome =
  'dated' | 'undated' | 'editors-unrecoverable' | 'bytes-missing' | 'stale-chunks' | 'raced' | 'failed';

export type BackfillResult = {
  counts: Record<Outcome, number>;
  missingBytes: string[];
  staleChunks: string[];
  failures: string[];
};

type CandidateFile = Pick<
  IFabFile,
  'filePath' | 'mimeType' | 'sourceType' | 'driveMd5Checksum' | 'documentDate' | 'documentDateSource' | 'serverTextHash'
> & { _id: Types.ObjectId };

const ELIGIBLE = {
  documentDate: { $exists: false },
  // Cheap pre-filter for a content rewrite, which replaces the stored bytes but keeps the old chunks
  // until the next re-chunk. FAB_FILE_CONTENT_REWRITE_PATCH writes an explicit null here, which a
  // completed chunk pass never does. Not sufficient on its own: backfill-chunk-char-length.ts refills
  // it from the OLD chunks, so servesStoredBytes is the check that actually decides.
  chunkedCharCount: { $not: { $type: 'null' } },
};

/** Returns an error message for the first invalid option, or undefined when all are usable. */
export function checkOptions(opts: Pick<BackfillOptions, 'batchSize' | 'limit' | 'fileIds'>): string | undefined {
  // Integer >= 1: yargs yields NaN for a non-number, and 0 means an unbounded page under `.limit()`.
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) return '--batch-size must be an integer of at least 1';
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    return '--limit must be an integer of at least 1';
  }
  const badIds = opts.fileIds.filter(id => !mongoose.isObjectIdOrHexString(id));
  if (badIds.length > 0) return `--file-id is not an ObjectId: ${badIds.join(', ')}`;
  return undefined;
}

export function nextPageSize(opts: Pick<BackfillOptions, 'batchSize' | 'limit'>, processed: number): number {
  return opts.limit === undefined ? opts.batchSize : Math.min(opts.batchSize, opts.limit - processed);
}

export function candidateFilter(opts: Pick<BackfillOptions, 'fileIds'>, afterId: Types.ObjectId | undefined) {
  const idClause = {
    ...(afterId ? { $gt: afterId } : {}),
    ...(opts.fileIds.length > 0 ? { $in: opts.fileIds.map(id => new Types.ObjectId(id)) } : {}),
  };
  return {
    ...ELIGIBLE,
    deletedAt: null,
    chunked: true,
    // A file mid-chunk is about to get its date from that pass; leave it to it.
    chunkClaimedAt: null,
    // A pathless row (e.g. a system help-lake document) has no bytes to date and never will.
    filePath: { $type: 'string', $ne: '' },
    ...(Object.keys(idClause).length > 0 ? { _id: idClause } : {}),
  };
}

/**
 * Whether the served chunks were cut from the text now in storage. `serverTextHash` is written only
 * by a chunk commit (the hash of the text it chunked, or null for a text-less pass) and is nulled by
 * a content rewrite, so a mismatch with the re-extracted text means the bytes moved on since the
 * chunks were cut. Absent means the last chunk pass predates the hash (#1679): there is nothing to
 * compare, and the chunkedCharCount pre-filter is the only guard.
 */
function servesStoredBytes(file: CandidateFile, extractedText: string | undefined): boolean {
  if (file.serverTextHash === undefined) return true;
  return file.serverTextHash === (dataLakeService.computeServerTextHash(extractedText) ?? null);
}

/**
 * The file's stored bytes, or `undefined` when the S3 key no longer exists: a permanent data problem
 * no content pass can date, so it is reported and left untouched rather than counted as a failure
 * that would fail every rerun.
 */
async function readStoredBytes(file: CandidateFile, storage: BackfillDeps['storage']): Promise<Buffer | undefined> {
  if (!file.filePath) return undefined;
  try {
    return await storage.getContentAsBuffer(file.filePath);
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
    throw error;
  }
}

async function processFile(file: CandidateFile, opts: BackfillOptions, deps: BackfillDeps): Promise<Outcome> {
  const pinned = fabFilesService.resolveDocumentDateWithoutContent(file);
  const isEditorsFile = pinned !== undefined;

  let resolved = pinned;
  if (!resolved) {
    const content = await readStoredBytes(file, deps.storage);
    if (!content) return 'bytes-missing';
    await deps.chunker.chunkFile(content, file.mimeType);
    if (!servesStoredBytes(file, deps.chunker.getExtractedText())) return 'stale-chunks';
    resolved = fabFilesService.resolveDocumentDate(file, deps.chunker.getDocumentDate());
  }

  if (opts.execute) {
    // Native driver, not Model.updateOne: FabFileSchema's timestamps would otherwise bump updatedAt,
    // and a metadata backfill must not make every file in the corpus look freshly modified. The hash
    // guard makes a rewrite or re-chunk landing between the read and this write lose us the race.
    const { matchedCount } = await FabFile.collection.updateOne(
      {
        _id: file._id,
        deletedAt: null,
        ...ELIGIBLE,
        serverTextHash: file.serverTextHash === undefined ? { $exists: false } : file.serverTextHash,
      },
      { $set: resolved }
    );
    if (matchedCount === 0) return 'raced';
  }

  if (isEditorsFile) return 'editors-unrecoverable';
  return resolved.documentDate ? 'dated' : 'undated';
}

/** Pages through every eligible file in `_id` order. Assumes an open mongoose connection. */
export async function runBackfill(opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillResult> {
  const result: BackfillResult = {
    counts: {
      dated: 0,
      undated: 0,
      'editors-unrecoverable': 0,
      'bytes-missing': 0,
      'stale-chunks': 0,
      raced: 0,
      failed: 0,
    },
    missingBytes: [],
    staleChunks: [],
    failures: [],
  };
  let processed = 0;
  let afterId: Types.ObjectId | undefined;

  while (opts.limit === undefined || processed < opts.limit) {
    const page = await FabFile.find(candidateFilter(opts, afterId))
      .select('_id filePath mimeType sourceType driveMd5Checksum documentDate documentDateSource serverTextHash')
      .sort({ _id: 1 })
      .limit(nextPageSize(opts, processed))
      .lean<CandidateFile[]>();
    if (page.length === 0) break;
    // The cursor, not the shrinking candidate set, is what terminates a DRY-RUN pass (nothing gets
    // written, so the same page would repeat forever without it).
    afterId = page[page.length - 1]._id;

    for (const file of page) {
      try {
        const outcome = await processFile(file, opts, deps);
        result.counts[outcome]++;
        if (outcome === 'bytes-missing') result.missingBytes.push(file._id.toString());
        if (outcome === 'stale-chunks') result.staleChunks.push(file._id.toString());
      } catch (error) {
        // One unreadable file must not abort a corpus-wide sweep; it is left undated, so a rerun
        // retries it, and the exit code is non-zero so the failure is not mistaken for a clean run.
        result.counts.failed++;
        result.failures.push(file._id.toString());
        deps.log(`  ${file._id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      processed++;
    }
    deps.log(`  ${opts.execute ? 'processed' : '[dry-run] examined'} ${processed} file(s) so far`);
  }

  return result;
}

export function formatSummary(result: BackfillResult, execute: boolean): string[] {
  const { counts } = result;
  const lines = [
    `${execute ? 'Wrote' : 'Would write'} a date on ${counts.dated} file(s) and null on ${counts.undated} with no recoverable date; ` +
      `${counts['editors-unrecoverable']} unpinned Drive Editors file(s) set null without a download; ` +
      `${counts['bytes-missing']} skipped (stored bytes missing); ` +
      `${counts['stale-chunks']} skipped (served chunks predate the stored bytes); ` +
      `${counts.raced} skipped (changed by a concurrent pass); ${counts.failed} failed.`,
  ];
  if (result.missingBytes.length > 0) lines.push(`Missing-bytes file ids: ${result.missingBytes.join(', ')}`);
  if (result.staleChunks.length > 0) lines.push(`Stale-chunk file ids: ${result.staleChunks.join(', ')}`);
  if (result.failures.length > 0) lines.push(`Failed file ids: ${result.failures.join(', ')}`);
  return lines;
}

export function exitCode(result: BackfillResult): number {
  return result.failures.length > 0 ? 1 : 0;
}
