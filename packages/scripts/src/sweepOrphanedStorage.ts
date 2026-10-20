import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { isModerationEvidenceHold, type IFabFileVersion } from '@bike4mind/common';
import { FabFile } from '@bike4mind/database';

export type ObjectPresence = 'present' | 'absent' | 'error';

export interface SweepStorage {
  /** HEAD the key: 'absent' only for a definite NotFound, 'error' for anything else that failed. */
  head(key: string): Promise<ObjectPresence>;
  delete(key: string): Promise<unknown>;
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface BackupLister {
  /** One `files/<userId>/` prefix per user, from a delimiter listing (no per-file listing). */
  listUserPrefixes(): AsyncIterable<string>;
  listObjects(prefix: string): AsyncIterable<ListedObject>;
}

type Log = (message: string) => void;

const DELETE_BATCH = 50;
// Keeps each referenced-key query well under the 16 MB BSON limit, even for long keys.
const REF_QUERY_CHUNK = 1000;
const CURSOR_BATCH = 100;

/**
 * Keys some row still serves as its current file: a live row, or a soft-deleted one that a
 * data-lake restore could bring back. Both queries ride the { deletedAt, filePath } index.
 * `versions[].filePath` of other rows is not checked (no index): version keys embed the owning
 * fabFileId, and no copy flow reuses them.
 */
async function referencedFilePaths(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += REF_QUERY_CHUNK) {
    const chunk = keys.slice(i, i + REF_QUERY_CHUNK);
    const [live, deleted] = await Promise.all([
      FabFile.find({ filePath: { $in: chunk } }, { filePath: 1 }).lean<{ filePath: string }[]>(),
      FabFile.find({ deletedAt: { $ne: null }, filePath: { $in: chunk } }, { filePath: 1 })
        .setOptions({ includeDeleted: true })
        .lean<{ filePath: string }[]>(),
    ]);
    for (const row of [...live, ...deleted]) found.add(row.filePath);
  }
  return found;
}

/** Deletes in bounded batches; returns the keys whose delete rejected. A failure never throws. */
async function deleteKeys(storage: SweepStorage, keys: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    const outcomes = await Promise.allSettled(batch.map(key => storage.delete(key)));
    outcomes.forEach((outcome, j) => {
      if (outcome.status === 'rejected') failed.push(batch[j]);
    });
  }
  return failed;
}

export interface SweepVersionsResult {
  /** Rows whose version objects were deleted (or, in a dry run, would be). */
  rows: number;
  keys: number;
  /** Bytes those keys held, per the recorded versions[].fileSize. */
  bytes: number;
  /** Current object still present: a restorable soft delete (e.g. a data-lake delete). */
  skippedPresent: number;
  skippedHeadError: number;
  skippedNoFilePath: number;
  /** Version keys left alone because another row uses them as its current file. */
  skippedReferenced: number;
  deleteFailures: number;
}

/**
 * Deletes the retained-version objects of FabFiles a user deleted before deleteFabFile started
 * removing them (b4m-core/services/src/fabFileService/deleteStoredObjects.ts). Rows stay as they are.
 *
 * `deletedAt` alone is not the signal: a data-lake delete soft-deletes rows but keeps every object
 * so restoreDeletedDataLake can undelete them. Only a row whose current `filePath` object is gone
 * (HEAD returns NotFound) is swept; present or unreadable means skip. Moderation evidence holds are
 * skipped by the same rule the delete path uses.
 */
export async function sweepOrphanedVersions(options: {
  dryRun: boolean;
  storage: SweepStorage;
  log?: Log;
}): Promise<SweepVersionsResult> {
  const { dryRun, storage, log = console.log } = options;
  const result: SweepVersionsResult = {
    rows: 0,
    keys: 0,
    bytes: 0,
    skippedPresent: 0,
    skippedHeadError: 0,
    skippedNoFilePath: 0,
    skippedReferenced: 0,
    deleteFailures: 0,
  };

  // Small batches: each row costs network round trips, and a getMore that arrives after the
  // server's idle cursor timeout (10 min by default) fails with CursorNotFound.
  const cursor = FabFile.find(
    { deletedAt: { $ne: null }, 'versions.0': { $exists: true } },
    { filePath: 1, versions: 1, moderationStatus: 1, blockReason: 1 }
  )
    .setOptions({ includeDeleted: true })
    .batchSize(CURSOR_BATCH)
    .lean<{
      _id: unknown;
      filePath?: string;
      versions: IFabFileVersion[];
      moderationStatus?: string | null;
      blockReason?: string | null;
    }>()
    .cursor();

  for await (const row of cursor) {
    const id = String(row._id);
    if (isModerationEvidenceHold(row)) continue;

    // Same key rule as deleteRetainedVersions: distinct, non-empty, never the current file.
    const sizes = new Map<string, number>();
    for (const v of row.versions ?? []) {
      const key = v?.filePath;
      if (typeof key === 'string' && key.length > 0 && key !== row.filePath && !sizes.has(key))
        sizes.set(key, v.fileSize ?? 0);
    }
    if (sizes.size === 0) continue;

    if (!row.filePath) {
      result.skippedNoFilePath += 1;
      log(`[sweep-orphaned-storage] ${id}: no filePath to check, skipped`);
      continue;
    }
    const presence = await storage.head(row.filePath);
    if (presence === 'present') {
      result.skippedPresent += 1;
      continue;
    }
    if (presence === 'error') {
      result.skippedHeadError += 1;
      log(`[sweep-orphaned-storage] ${id}: HEAD ${row.filePath} failed, skipped`);
      continue;
    }

    const referenced = await referencedFilePaths([...sizes.keys()]);
    const keys = [...sizes.keys()].filter(key => !referenced.has(key));
    result.skippedReferenced += referenced.size;
    if (keys.length === 0) continue;

    let failed = new Set<string>();
    if (!dryRun) {
      failed = new Set(await deleteKeys(storage, keys));
      result.deleteFailures += failed.size;
      failed.forEach(key => log(`[sweep-orphaned-storage] ${id}: failed to delete ${key}`));
    }
    const done = keys.filter(key => !failed.has(key));
    if (done.length === 0) continue;
    const bytes = done.reduce((sum, key) => sum + (sizes.get(key) ?? 0), 0);
    result.rows += 1;
    result.keys += done.length;
    result.bytes += bytes;
    log(
      `[sweep-orphaned-storage] ${id}: ${dryRun ? 'would delete' : 'deleted'} ${done.length} version(s), ${bytes} bytes`
    );
  }

  return result;
}

export interface SweepBackupsResult {
  /** User prefixes scanned. */
  users: number;
  keys: number;
  bytes: number;
  skippedYoung: number;
  skippedReferenced: number;
  deleteFailures: number;
}

const LEGACY_BACKUP_KEY = /^files\/[^/]+\/backups\/[^/]/;

/**
 * Deletes pre-overwrite text-edit backups left under the legacy `files/<userId>/backups/` keys.
 * New backups go to `text-edit-backups/`, which a lifecycle rule expires (infra/buckets.ts); a
 * lifecycle filter cannot match the mid-key `backups/` segment, hence this sweep. No row
 * references these keys, but any key a row serves as its current file is kept regardless.
 */
export async function sweepLegacyBackups(options: {
  dryRun: boolean;
  olderThanDays: number;
  lister: BackupLister;
  storage: SweepStorage;
  log?: Log;
  now?: Date;
}): Promise<SweepBackupsResult> {
  const { dryRun, olderThanDays, lister, storage, log = console.log, now = new Date() } = options;
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  const result: SweepBackupsResult = {
    users: 0,
    keys: 0,
    bytes: 0,
    skippedYoung: 0,
    skippedReferenced: 0,
    deleteFailures: 0,
  };

  for await (const userPrefix of lister.listUserPrefixes()) {
    result.users += 1;
    const candidates: ListedObject[] = [];
    for await (const object of lister.listObjects(`${userPrefix}backups/`)) {
      if (!LEGACY_BACKUP_KEY.test(object.key)) continue;
      if (object.lastModified.getTime() >= cutoff) {
        result.skippedYoung += 1;
        continue;
      }
      candidates.push(object);
    }
    if (candidates.length === 0) continue;

    const referenced = await referencedFilePaths(candidates.map(o => o.key));
    result.skippedReferenced += referenced.size;
    const doomed = candidates.filter(o => !referenced.has(o.key));
    if (doomed.length === 0) continue;

    let failed = new Set<string>();
    if (!dryRun) {
      failed = new Set(
        await deleteKeys(
          storage,
          doomed.map(o => o.key)
        )
      );
      result.deleteFailures += failed.size;
      failed.forEach(key => log(`[sweep-orphaned-storage] failed to delete ${key}`));
    }
    const done = doomed.filter(o => !failed.has(o.key));
    const bytes = done.reduce((sum, o) => sum + o.size, 0);
    result.keys += done.length;
    result.bytes += bytes;
    log(
      `[sweep-orphaned-storage] ${userPrefix}backups/: ${dryRun ? 'would delete' : 'deleted'} ${done.length} key(s), ${bytes} bytes`
    );
  }

  return result;
}

export interface SweepArgs {
  apply: boolean;
  versions: boolean;
  backups: boolean;
  olderThanDays: number;
}

/** CLI flags. With neither --versions nor --backups, both passes run. */
export function parseSweepArgs(argv: string[]): SweepArgs {
  const args = { apply: false, versions: false, backups: false, olderThanDays: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--') continue;
    if (flag === '--apply') args.apply = true;
    else if (flag === '--versions') args.versions = true;
    else if (flag === '--backups') args.backups = true;
    else if (flag === '--older-than') {
      const value = argv[(i += 1)];
      const days = Number(value);
      // A typo must not silently fall back to the default on a run that deletes objects.
      if (!value?.trim() || !Number.isFinite(days) || days < 0)
        throw new Error(`--older-than needs a number of days >= 0, got "${value}"`);
      args.olderThanDays = days;
    } else throw new Error(`Unknown argument "${flag}"`);
  }
  if (!args.versions && !args.backups) {
    args.versions = true;
    args.backups = true;
  }
  return args;
}

/**
 * S3 HEAD errors that mean "no such object", as the SDK names them. HEAD has no body, so a missing
 * bucket also surfaces as NotFound; assertBucketReachable rules that out before a sweep starts.
 */
export function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
}

/** HeadBucket, so a wrong bucket or endpoint fails loudly instead of making every row look orphaned. */
export async function assertBucketReachable(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    throw new Error(`Bucket "${bucket}" is not reachable; refusing to sweep`, { cause: error });
  }
}

// EncodingType 'url' form-encodes keys (space as '+'), as botocore's unquote_plus decodes them.
// Without it a key holding an XML-invalid character breaks the listing parse.
const decodeListedKey = (key: string) => decodeURIComponent(key.replace(/\+/g, ' '));

async function* listPages(
  client: S3Client,
  input: { Bucket: string; Prefix: string; Delimiter?: string }
): AsyncGenerator<ListObjectsV2CommandOutput> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ ...input, EncodingType: 'url', ContinuationToken: token })
    );
    yield page;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/** HEAD/delete/list over one bucket. A HEAD maps to 'absent' only on a definite NotFound. */
export function s3SweepAdapters(client: S3Client, bucket: string): { storage: SweepStorage; lister: BackupLister } {
  return {
    storage: {
      async head(key) {
        try {
          await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return 'present';
        } catch (error) {
          return isNotFoundError(error) ? 'absent' : 'error';
        }
      },
      delete: key => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    },
    lister: {
      async *listUserPrefixes() {
        for await (const page of listPages(client, { Bucket: bucket, Prefix: 'files/', Delimiter: '/' }))
          for (const p of page.CommonPrefixes ?? []) if (p.Prefix) yield decodeListedKey(p.Prefix);
      },
      async *listObjects(prefix) {
        for await (const page of listPages(client, { Bucket: bucket, Prefix: prefix }))
          for (const o of page.Contents ?? [])
            if (o.Key && o.LastModified)
              yield { key: decodeListedKey(o.Key), size: o.Size ?? 0, lastModified: o.LastModified };
      },
    },
  };
}
