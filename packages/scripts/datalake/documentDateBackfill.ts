/**
 * The metadata-only documentDate backfill (#3196), importable so it can be tested against a real
 * database. The CLI wrapper and the operator-facing rationale live in backfill-document-date.ts.
 */

import mongoose, { Types } from 'mongoose';
import { FabFileSourceType, type IFabFile } from '@bike4mind/common';
import { FabFile } from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import type { ExtractedDocumentDate, S3Storage } from '@bike4mind/fab-pipeline';

export type BackfillOptions = {
  execute: boolean;
  batchSize: number;
  limit?: number;
  fileIds: string[];
  /** Resume point: only files with a greater `_id` are selected. */
  afterId?: string;
  /** Date files last chunked before serverTextHash existed, whose served chunks cannot be verified. */
  trustUnhashed: boolean;
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
  /** Eligible files left out of the selection because they have no serverTextHash (see UNHASHED). */
  unhashed: number;
  /** Files dated or nulled under `trustUnhashed` with no hash to verify the served chunks against. */
  unverified: number;
  /** Set when the run stopped at `limit`: the `afterId` that continues from where it left off. */
  resumeAfterId?: string;
  missingBytes: string[];
  staleChunks: string[];
  failures: string[];
};

type CandidateFile = Pick<
  IFabFile,
  | 'filePath'
  | 'mimeType'
  | 'sourceType'
  | 'driveMd5Checksum'
  | 'documentDate'
  | 'documentDateSource'
  | 'serverTextHash'
  | 'chunkedCharCount'
> & { _id: Types.ObjectId };

/** The rows this backfill may write. Spread into both the selection and the guarded write. */
const ELIGIBLE = {
  documentDate: { $exists: false },
  deletedAt: null,
  chunked: true,
  // A file mid-chunk is about to get its date from that pass; leave it to it. Not `chunkClaimedAt`:
  // the release clears only isChunking, so that stamp stays set on every file claimed since it shipped.
  isChunking: { $ne: true },
  // A pathless row (e.g. a system help-lake document) has no bytes to date and never will.
  filePath: { $type: 'string', $ne: '' },
  // Cheap pre-filter for a content rewrite, which replaces the stored bytes but keeps the old chunks
  // until the next re-chunk. FAB_FILE_CONTENT_REWRITE_PATCH writes an explicit null here, which a
  // completed chunk pass never does. Not a guard: backfill-chunk-char-length.ts refills it from the
  // OLD chunks, so servesStoredBytes is the check that actually decides.
  chunkedCharCount: { $not: { $type: 'null' } },
};

/**
 * Mongo form of fabFilesService.isUnpinnedDriveEditorsFile; must stay in sync with it. `$in: [null, '']`
 * matches the absent, null and empty checksum that the predicate's falsy test accepts.
 */
const UNPINNED_DRIVE_EDITORS = {
  sourceType: FabFileSourceType.GOOGLE_DRIVE,
  driveMd5Checksum: { $in: [null, ''] },
};

/**
 * Files last chunked before serverTextHash existed (#1679): their served chunks cannot be verified, so
 * they are left out of the selection unless `trustUnhashed`. Kept out of the query rather than skipped
 * per file, so they never consume the `--limit` budget. An unpinned Editors file is exempt: it is nulled
 * without reading its bytes, so there are no chunks to verify.
 */
const UNHASHED = { serverTextHash: { $exists: false }, $nor: [UNPINNED_DRIVE_EDITORS] };

export type BackfillArgv = {
  execute: boolean;
  'batch-size': number;
  limit?: number;
  'file-id': string[];
  'after-id'?: string;
  'trust-unhashed': boolean;
};

/** Maps the CLI's parsed flags onto the options runBackfill takes. */
export function toBackfillOptions(argv: BackfillArgv): BackfillOptions {
  return {
    execute: argv.execute,
    batchSize: argv['batch-size'],
    limit: argv.limit,
    fileIds: argv['file-id'],
    afterId: argv['after-id'],
    trustUnhashed: argv['trust-unhashed'],
  };
}

/** Returns an error message for the first invalid option, or undefined when all are usable. */
export function checkOptions(
  opts: Pick<BackfillOptions, 'batchSize' | 'limit' | 'fileIds' | 'afterId'>
): string | undefined {
  // Integer >= 1: yargs yields NaN for a non-number, and 0 means an unbounded page under `.limit()`.
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) return '--batch-size must be an integer of at least 1';
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    return '--limit must be an integer of at least 1';
  }
  const badIds = opts.fileIds.filter(id => !mongoose.isObjectIdOrHexString(id));
  if (badIds.length > 0) return `--file-id is not an ObjectId: ${badIds.join(', ')}`;
  if (opts.afterId !== undefined && !mongoose.isObjectIdOrHexString(opts.afterId)) {
    return `--after-id is not an ObjectId: ${opts.afterId}`;
  }
  return undefined;
}

export function nextPageSize(opts: Pick<BackfillOptions, 'batchSize' | 'limit'>, processed: number): number {
  return opts.limit === undefined ? opts.batchSize : Math.min(opts.batchSize, opts.limit - processed);
}

function idFilter(opts: Pick<BackfillOptions, 'fileIds'>, afterId: Types.ObjectId | undefined) {
  const idClause = {
    ...(afterId ? { $gt: afterId } : {}),
    ...(opts.fileIds.length > 0 ? { $in: opts.fileIds.map(id => new Types.ObjectId(id)) } : {}),
  };
  return Object.keys(idClause).length > 0 ? { _id: idClause } : {};
}

function candidateFilter(
  opts: Pick<BackfillOptions, 'fileIds' | 'trustUnhashed'>,
  afterId: Types.ObjectId | undefined
) {
  return {
    ...ELIGIBLE,
    ...idFilter(opts, afterId),
    ...(opts.trustUnhashed ? {} : { $nor: [UNHASHED] }),
  };
}

/**
 * Whether the served chunks were cut from the text now in storage. `serverTextHash` is written only
 * by a chunk commit (the hash of the text it chunked, or null for a text-less pass) and is nulled by
 * a content rewrite, so a mismatch with the re-extracted text means the bytes moved on since the
 * chunks were cut. Absent means the last chunk pass predates the hash (#1679): there is nothing to
 * compare, so such a file is selected only under `trustUnhashed`, which accepts that risk.
 */
function servesStoredBytes(file: CandidateFile, extractedText: string | undefined): boolean {
  if (file.serverTextHash === undefined) return true;
  // Null is also the rewrite tombstone. Only a text-less commit leaves chunkedCharCount at 0; a
  // tombstone refilled by backfill-chunk-char-length carries the old chunks' sum instead.
  if (file.serverTextHash === null && file.chunkedCharCount !== 0) return false;
  return file.serverTextHash === (dataLakeService.computeServerTextHash(extractedText) ?? null);
}

/**
 * The file's stored bytes, or `undefined` when the S3 key no longer exists or holds zero bytes: a
 * permanent data problem no content pass can date, so it is reported and left untouched rather than
 * counted as a failure that would fail every rerun. A non-empty object that will not decode stays a
 * failure: that can be a chunker bug, and hiding it would hide the fix.
 */
async function readStoredBytes(file: CandidateFile, storage: BackfillDeps['storage']): Promise<Buffer | undefined> {
  if (!file.filePath) return undefined;
  try {
    const content = await storage.getContentAsBuffer(file.filePath);
    return content.length > 0 ? content : undefined;
  } catch (error) {
    // Both names mean a missing object, as the sibling S3 call sites treat them.
    if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) return undefined;
    throw error;
  }
}

/** A bare `null` would also match an absent field, so each state gets an exact match. */
function pinServerTextHash(hash: CandidateFile['serverTextHash']) {
  if (hash === undefined) return { $exists: false };
  if (hash === null) return { $type: 'null' };
  return hash;
}

async function processFile(file: CandidateFile, opts: BackfillOptions, deps: BackfillDeps): Promise<Outcome> {
  let resolved = fabFilesService.resolveDocumentDateWithoutContent(file);
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
        ...ELIGIBLE,
        serverTextHash: pinServerTextHash(file.serverTextHash),
      },
      { $set: resolved }
    );
    if (matchedCount === 0) return 'raced';
  }

  if (fabFilesService.isUnpinnedDriveEditorsFile(file)) return 'editors-unrecoverable';
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
    unhashed: 0,
    unverified: 0,
    missingBytes: [],
    staleChunks: [],
    failures: [],
  };
  let processed = 0;
  let afterId = opts.afterId ? new Types.ObjectId(opts.afterId) : undefined;

  if (!opts.trustUnhashed) {
    result.unhashed = await FabFile.countDocuments({ ...ELIGIBLE, ...idFilter(opts, afterId), ...UNHASHED });
  }

  while (opts.limit === undefined || processed < opts.limit) {
    const page = await FabFile.find(candidateFilter(opts, afterId))
      .select(
        '_id filePath mimeType sourceType driveMd5Checksum documentDate documentDateSource serverTextHash chunkedCharCount'
      )
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
        if ((outcome === 'dated' || outcome === 'undated') && file.serverTextHash === undefined) result.unverified++;
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

  // Skipped files (missing bytes, stale chunks) stay eligible, so a limited rerun from the start would
  // re-examine them forever; the cursor lets it continue past them instead.
  if (opts.limit !== undefined && processed >= opts.limit && afterId) result.resumeAfterId = afterId.toString();
  return result;
}

export function formatSummary(result: BackfillResult, execute: boolean): string[] {
  const { counts } = result;
  const lines = [
    `${execute ? 'Wrote' : 'Would write'} a date on ${counts.dated} file(s) and null on ${counts.undated} with no recoverable date; ` +
      `${counts['editors-unrecoverable']} unpinned Drive Editors file(s) set null without a download; ` +
      `${counts['bytes-missing']} skipped (stored bytes missing or empty); ` +
      `${counts['stale-chunks']} skipped (served chunks predate the stored bytes); ` +
      `${result.unhashed} not selected (chunked before serverTextHash, so the served chunks cannot be verified; ` +
      `--trust-unhashed dates them); ` +
      `${counts.raced} skipped (changed by a concurrent pass); ${counts.failed} failed.`,
  ];
  if (result.unverified > 0) {
    lines.push(`${result.unverified} of those dated or nulled without verifying the served chunks (--trust-unhashed).`);
  }
  if (result.resumeAfterId) lines.push(`Stopped at --limit; continue with --after-id ${result.resumeAfterId}`);
  if (result.missingBytes.length > 0) lines.push(`Missing-bytes file ids: ${result.missingBytes.join(', ')}`);
  if (result.staleChunks.length > 0) lines.push(`Stale-chunk file ids: ${result.staleChunks.join(', ')}`);
  if (result.failures.length > 0) lines.push(`Failed file ids: ${result.failures.join(', ')}`);
  return lines;
}

export function exitCode(result: BackfillResult): number {
  return result.failures.length > 0 ? 1 : 0;
}
