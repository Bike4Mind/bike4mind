#!/usr/bin/env tsx
/**
 * Bulk-ingest a directory tree of PDFs into an EXISTING data lake.
 *
 * Uses the same server-side ingestion primitive as the API (`fabFilesService.createFabFile`
 * with the bytes in hand): each PDF is uploaded to the fabFile bucket and recorded as a
 * FabFile tagged `datalake:<slug>`. The bucket-wide S3 ObjectCreated notification then fires
 * the standard pipeline (objectCreated -> fabFileChunkQueue -> fabFileVectorizeQueue), so
 * chunking/vectorization need no extra wiring. Note `enableAutoChunk` is evaluated at S3
 * event time only: uploading while it is OFF leaves files complete-but-unchunked, and the
 * drain must then be driven manually in waves via --requeue-stragglers (50 per run).
 *
 * Idempotent/resumable: candidates already in the lake (by sha256 contentHash, falling back
 * to fileName+fileSize) are skipped, so re-running after a partial failure only uploads the
 * remainder. Stale 'pending' twins (lost S3 event) are soft-deleted and re-uploaded. If an
 * S3 PutObject succeeds but the FabFile insert fails, the orphaned object is harmless (no
 * doc, event no-ops). Dry-run by default; pass --execute to write.
 *
 * Modes:
 *   (default)              plan + upload the PDFs under --dir
 *   --status               read-only pipeline progress report for the lake
 *   --requeue-stragglers   re-enqueue complete-but-unchunked files (lost S3 events)
 *
 * Usage (needs DB + AWS resources, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/ingest-pdf-datalake.ts \
 *     --dir /path/to/pdfs --slug <lake-slug> --userId <ownerId>
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/ingest-pdf-datalake.ts \
 *     --dir /path/to/pdfs --slug <lake-slug> --userId <ownerId> --execute
 *
 * --userId must be the lake's creator or a platform admin (same write gate as the API).
 * Pre-flight: the owner's storageLimit must cover the corpus (default is 1000 MB).
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import pLimit from 'p-limit';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  buildDataLakeMembershipFilter,
  connectDB,
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  FabFile,
  Organization,
  User,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { DATA_LAKES, KnowledgeType } from '@bike4mind/common';
import {
  filterPdfCandidates,
  planUploads,
  resolveLakeTarget,
  splitStalePending,
  type CandidateFile,
  type ExistingLakeDoc,
  type HashedCandidate,
  type LakeTarget,
} from './ingestPlan.js';

const PDF_MIME = 'application/pdf';
/** Default max per-file size (MB) when the MaxFileSize admin setting is unset; parity with fabFileService. */
const DEFAULT_MAX_FILE_MB = 20;
/** Only rescue files older than this - keep in sync with server/worker/chunkScan.ts. */
const STRAGGLER_MIN_AGE_MS = 2 * 60_000;

interface Options {
  dir?: string;
  slug: string;
  userId: string;
  organizationId?: string;
  concurrency: number;
  limit?: number;
  execute: boolean;
  status: boolean;
  requeueStragglers: boolean;
  requeueLimit: number;
}

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

async function collectFiles(dir: string): Promise<CandidateFile[]> {
  const relPaths = await glob('**/*', { cwd: dir, nodir: true, dot: true });
  const files: CandidateFile[] = [];
  for (const relativePath of relPaths.sort()) {
    const absPath = path.join(dir, relativePath);
    const { size } = await stat(absPath);
    files.push({ absPath, relativePath, fileName: path.basename(relativePath), fileSize: size });
  }
  return files;
}

/**
 * Every lake-file query here runs on the shared membership predicate (meta-tag OR a
 * fileTagPrefix match on a file the creator owns), so this script agrees with what
 * computeDataLakeStats counts. A static lake carries no creator, so it fails closed
 * to the meta-tag arm - see buildDataLakeMembershipFilter.
 */
const membership = (lake: LakeTarget) =>
  buildDataLakeMembershipFilter({
    datalakeTag: lake.datalakeTag,
    fileTagPrefix: lake.fileTagPrefix,
    creatorUserId: lake.createdByUserId,
  });

/** Live lake files: members, not soft-deleted, not archived (parity with computeDataLakeStats). */
const liveFilter = (lake: LakeTarget) => ({ ...membership(lake), deletedAt: null, archivedAt: null });

/** Complete-but-unchunked lake files (lost S3 event / failed extraction).
 * Keep in sync with buildFabFileChunkScanFilter in apps/client/server/worker/chunkScan.ts. */
const stragglerFilter = (lake: LakeTarget) => ({
  ...membership(lake),
  status: 'complete',
  chunkCount: 0,
  isChunking: { $ne: true },
  createdAt: { $lt: new Date(Date.now() - STRAGGLER_MIN_AGE_MS) },
  deletedAt: null,
});

async function statusReport(lake: LakeTarget): Promise<number> {
  const match = liveFilter(lake);
  const [agg] = await FabFile.aggregate<{
    files: number;
    bytes: number;
    complete: number;
    chunkedFiles: number;
    vectorizedFiles: number;
    failedFiles: number;
    chunks: number;
    vectorizedChunks: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        files: { $sum: 1 },
        bytes: { $sum: { $ifNull: ['$fileSize', 0] } },
        complete: { $sum: { $cond: [{ $eq: ['$status', 'complete'] }, 1, 0] } },
        chunkedFiles: { $sum: { $cond: [{ $gt: ['$chunkCount', 0] }, 1, 0] } },
        vectorizedFiles: { $sum: { $cond: [{ $eq: ['$vectorized', true] }, 1, 0] } },
        failedFiles: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$error', ''] }, ''] }, 0, 1] } },
        chunks: { $sum: { $ifNull: ['$chunkCount', 0] } },
        vectorizedChunks: { $sum: { $ifNull: ['$vectorizedChunkCount', 0] } },
      },
    },
  ]);

  if (!agg) {
    console.log(`Lake "${lake.slug}" (${lake.datalakeTag}): no files.`);
    return 0;
  }

  console.log(`Lake "${lake.slug}" (${lake.datalakeTag})`);
  console.log(`  files:            ${agg.files} (${mb(agg.bytes)})`);
  console.log(`  upload complete:  ${agg.complete}/${agg.files}`);
  console.log(`  chunked:          ${agg.chunkedFiles}/${agg.files} (${agg.chunks} chunks)`);
  console.log(`  vectorized files: ${agg.vectorizedFiles}/${agg.files} (${agg.vectorizedChunks}/${agg.chunks} chunks)`);
  if (agg.failedFiles > 0) {
    console.log(
      `  FAILED (error set by the pipeline): ${agg.failedFiles} - inspect via admin DLQ / triage individually`
    );
  }

  const stalePendingCount = await FabFile.countDocuments({
    ...match,
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - STRAGGLER_MIN_AGE_MS) },
  });
  if (stalePendingCount > 0) {
    console.log(`  STALE PENDING (lost S3 event): ${stalePendingCount} - re-run the ingest command to repair`);
  }

  const stragglers = await FabFile.find(stragglerFilter(lake), 'fileName error')
    .sort({ createdAt: 1 })
    .limit(20)
    .lean();
  const stragglerCount = await FabFile.countDocuments(stragglerFilter(lake));
  if (stragglerCount > 0) {
    console.log(`  STRAGGLERS (complete >2min ago, 0 chunks): ${stragglerCount}`);
    for (const s of stragglers) console.log(`    - ${s.fileName} (${s._id})${s.error ? ` [failed: ${s.error}]` : ''}`);
    if (stragglerCount > stragglers.length) console.log(`    ... and ${stragglerCount - stragglers.length} more`);
    console.log('  Re-enqueue the non-failed ones with --requeue-stragglers --execute');
  } else {
    console.log('  stragglers:       none');
  }
  return 0;
}

async function requeueStragglers(lake: LakeTarget, opts: Options): Promise<number> {
  // Exclude files the pipeline already marked failed (markFailedIfNotAlready sets `error`):
  // SQS retried them 3x before DLQ, so blind re-enqueueing only churns slots. `$in` also
  // matches a missing field. Failed files stay visible in --status for manual triage.
  const files = await FabFile.find({ ...stragglerFilter(lake), error: { $in: [null, ''] } }, 'fileName userId')
    .sort({ createdAt: 1 })
    .limit(opts.requeueLimit)
    .lean();

  if (files.length === 0) {
    console.log('No stragglers found.');
    return 0;
  }
  console.log(`${opts.execute ? '' : '(dry-run) '}Re-enqueueing ${files.length} straggler(s):`);
  for (const f of files) console.log(`  - ${f.fileName} (${f._id})`);
  if (!opts.execute) return 0;

  const queueUrl = Resource.fabFileChunkQueue.url;
  const sqs = new SQSClient({});
  for (const f of files) {
    // Reset processing flags first (parity with POST /api/files/reprocess) so a
    // partially-failed extraction starts clean.
    await FabFile.updateOne(
      { _id: f._id },
      {
        $set: {
          isChunking: false,
          chunked: false,
          chunkCount: 0,
          vectorized: false,
          vectorizedChunkCount: 0,
          notes: '',
        },
      }
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ fabFileId: String(f._id), userId: String(f.userId) }),
      })
    );
  }
  console.log(`Re-enqueued ${files.length} file(s) to fabFileChunkQueue.`);
  return 0;
}

async function ingest(lake: LakeTarget, opts: Options): Promise<number> {
  if (!opts.dir) throw new Error('--dir is required to ingest');

  const user = await User.findById(opts.userId);
  if (!user) throw new Error(`User ${opts.userId} not found`);

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const maxFileBytes = getSettingsValue('MaxFileSize', settings, DEFAULT_MAX_FILE_MB) * 1024 * 1024;

  console.log(`Scanning ${opts.dir} ...`);
  const allFiles = await collectFiles(opts.dir);
  const { accepted, skippedOversize, skippedNonPdf } = filterPdfCandidates(allFiles, maxFileBytes);

  console.log(`Hashing ${accepted.length} PDF(s) ...`);
  const hashLimiter = pLimit(8);
  const hashed: HashedCandidate[] = await Promise.all(
    accepted.map(f =>
      hashLimiter(async () => ({
        ...f,
        contentHash: createHash('sha256')
          .update(await readFile(f.absPath))
          .digest('hex'),
      }))
    )
  );

  // archivedAt: null mirrors the repo's own lake-dedup semantics (findByContentHashesInDataLake).
  const existingDocs = await FabFile.find(liveFilter(lake), 'fileName fileSize contentHash status createdAt').lean();
  const { usable: existing, stalePending } = splitStalePending(
    existingDocs.map((d): ExistingLakeDoc => ({
      id: String(d._id),
      fileName: d.fileName,
      fileSize: d.fileSize,
      contentHash: d.contentHash,
      status: d.status,
      createdAt: d.createdAt,
    })),
    new Date(Date.now() - STRAGGLER_MIN_AGE_MS)
  );
  const plan = planUploads(hashed, existing);
  const toUpload = typeof opts.limit === 'number' ? plan.toUpload.slice(0, opts.limit) : plan.toUpload;
  const plannedBytes = toUpload.reduce((sum, f) => sum + f.fileSize, 0);

  console.log(`\nPlan for lake "${lake.slug}" (${lake.datalakeTag}):`);
  console.log(`  upload:               ${toUpload.length} file(s), ${mb(plannedBytes)}`);
  if (typeof opts.limit === 'number' && plan.toUpload.length > toUpload.length)
    console.log(`  deferred by --limit:  ${plan.toUpload.length - toUpload.length}`);
  console.log(`  already in lake:      ${plan.skippedExisting.length}`);
  console.log(`  duplicates in corpus: ${plan.skippedDuplicateInBatch.length}`);
  if (stalePending.length > 0)
    console.log(`  stale pending (lost S3 event, twin gets soft-deleted on re-upload): ${stalePending.length}`);
  console.log(`  oversize (>=${Math.round(maxFileBytes / 1024 / 1024)}MB):     ${skippedOversize.length}`);
  for (const f of skippedOversize) console.log(`    ! ${f.relativePath} (${mb(f.fileSize)})`);
  console.log(`  non-pdf/hidden:       ${skippedNonPdf.length}`);

  // Advisory quota check; the service re-checks per file. Org-scoped ingest is governed
  // by the org's limit instead, so only warn when no organizationId is given.
  const currentBytes = user.currentStorageSize ?? 0;
  const limitBytes = (user.storageLimit ?? 1000) * 1_000_000;
  console.log(`\nOwner storage: ${mb(currentBytes)} used of ${mb(limitBytes)} limit; plan adds ${mb(plannedBytes)}`);
  if (!opts.organizationId && currentBytes + plannedBytes > limitBytes) {
    console.log('  !! plan exceeds the owner storageLimit - raise it (units: MB) before --execute');
    if (opts.execute) return 1;
  }

  if (!opts.execute) {
    console.log('\n(dry-run) Nothing written. Re-run with --execute to upload.');
    return 0;
  }
  if (toUpload.length === 0) {
    console.log('\nNothing to upload.');
    return 0;
  }

  // Soft-delete the stale-pending twins of files we are about to re-upload, so lake
  // stats stay honest (same recovery the batch upload-complete route applies to
  // 0-chunk orphans). Their S3 event is >2min gone; a late event for a soft-deleted
  // doc no-ops (objectCreated's findOne cannot see soft-deleted docs).
  const reuploadHashes = new Set(toUpload.map(f => f.contentHash));
  const reuploadNameSizes = new Set(toUpload.map(f => `${f.fileName} ${f.fileSize}`));
  const orphans = stalePending.filter(
    d => (d.contentHash && reuploadHashes.has(d.contentHash)) || reuploadNameSizes.has(`${d.fileName} ${d.fileSize}`)
  );
  if (orphans.length > 0) {
    console.log(`Soft-deleting ${orphans.length} stale pending twin(s) before re-upload ...`);
    for (const orphan of orphans) {
      await fabFileRepository.update({ id: orphan.id, deletedAt: new Date() });
    }
  }

  const s3 = new S3Client({});
  const bucket = Resource.fabFileBucket.name;
  const adapters = {
    db: {
      fabFiles: FabFile,
      adminSettings: adminSettingsRepository,
      users: User,
      // Wrap instead of passing the model: createFabFile detaches this method
      // (`db.organizations?.findById`), and an unbound Model.findById throws.
      organizations: { findById: (id: string) => Organization.findById(id).exec() },
      dataLakes: dataLakeRepository,
    },
    storage: {
      upload: async (
        filepath: string,
        content: string | Buffer,
        options?: { ContentType?: string; ContentLength?: number }
      ) => {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: filepath,
            Body: content,
            ContentType: options?.ContentType,
            ContentLength: options?.ContentLength,
          })
        );
        return filepath;
      },
      generateSignedUrl: (filepath: string, expireInSeconds: number, type: 'get' | 'put' = 'get') =>
        getSignedUrl(
          s3,
          type === 'put'
            ? new PutObjectCommand({ Bucket: bucket, Key: filepath })
            : new GetObjectCommand({ Bucket: bucket, Key: filepath }),
          { expiresIn: expireInSeconds }
        ),
    },
  };

  // Clamp: each concurrent upload is a concurrent objectCreated lambda invocation.
  const concurrency = Math.min(8, Math.max(1, opts.concurrency));
  console.log(`\nUploading ${toUpload.length} file(s) at concurrency ${concurrency} ...`);
  const uploadLimiter = pLimit(concurrency);
  const failures: { file: HashedCandidate; error: string }[] = [];
  let done = 0;

  await Promise.all(
    toUpload.map(file =>
      uploadLimiter(async () => {
        try {
          const content = await readFile(file.absPath);
          await fabFilesService.createFabFile(
            opts.userId,
            {
              fileName: file.fileName,
              mimeType: PDF_MIME,
              contentType: PDF_MIME,
              fileSize: file.fileSize,
              type: KnowledgeType.FILE,
              content,
              contentHash: file.contentHash,
              relativePath: file.relativePath,
              tags: [{ name: lake.datalakeTag, strength: 1 }],
              ...(opts.organizationId && { organizationId: opts.organizationId }),
            },
            adapters
          );
          done++;
          console.log(`  [${done}/${toUpload.length}] ok ${file.relativePath} (${mb(file.fileSize)})`);
        } catch (error) {
          failures.push({ file, error: error instanceof Error ? error.message : String(error) });
          console.error(`  FAIL ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    )
  );

  // Lake stats are normally recomputed on batch completion; this path has no batch.
  // Static lakes have no DB doc to persist stats on.
  if (lake.source === 'db' && lake.id) {
    const stats = await dataLakeService.recomputeLakeStats(
      {
        id: lake.id,
        datalakeTag: lake.datalakeTag,
        fileTagPrefix: lake.fileTagPrefix ?? '',
        createdByUserId: lake.createdByUserId ?? '',
      },
      { db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository } }
    );
    console.log(
      `\nUploaded ${done}/${toUpload.length}; lake now has ${stats.fileCount} file(s), ${mb(stats.totalSizeBytes)}.`
    );
  } else {
    console.log(`\nUploaded ${done}/${toUpload.length} into static lake ${lake.datalakeTag}.`);
  }
  console.log('Chunking/vectorization continue async - watch with --status.');

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  FAIL ${f.file.relativePath}: ${f.error}`);
    console.error('Re-run the same command to retry only the failed files (dedup skips the rest).');
    return 1;
  }
  return 0;
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage})`);

  // Pass the org through: the org-less overload only matches lakes with no organizationId,
  // so an org-scoped lake is invisible without it. Static registry lakes (opti-knowledge,
  // premium overlay entries) have no DB doc at all and resolve from DATA_LAKES.
  const dbLake = await dataLakeRepository.findBySlug(opts.slug, opts.organizationId);
  const lake = resolveLakeTarget(
    opts.slug,
    dbLake
      ? {
          id: dbLake.id,
          slug: dbLake.slug,
          name: dbLake.name,
          datalakeTag: dbLake.datalakeTag,
          fileTagPrefix: dbLake.fileTagPrefix,
          createdByUserId: dbLake.createdByUserId,
        }
      : null,
    DATA_LAKES
  );
  if (!lake)
    throw new Error(
      `Data lake with slug "${opts.slug}" found neither in Mongo nor in the static registry` +
        (opts.organizationId ? ` (org ${opts.organizationId})` : ' (org-scoped? pass --organizationId)')
    );
  console.log(`Target lake: "${lake.name}" (${lake.datalakeTag}, ${lake.source})`);

  // --status is read-only; the write gate applies to the mutating modes only.
  if (opts.status) return statusReport(lake);

  const owner = await User.findById(opts.userId);
  if (lake.source === 'db') {
    // Same write gate as the API ingest door: creator or platform admin only.
    await dataLakeService.assertCanWriteDataLakeTags(
      { userId: opts.userId, isAdmin: !!owner?.isAdmin },
      [lake.datalakeTag],
      { db: { dataLakes: dataLakeRepository } }
    );
  } else if (!owner?.isAdmin) {
    // Static lakes have no creator to authorize against; the API rejects their tags
    // outright, so direct ingest is an admin-only operation by construction.
    throw new Error('Ingesting into a static registry lake requires a platform-admin --userId');
  }

  if (opts.requeueStragglers) return requeueStragglers(lake, opts);
  return ingest(lake, opts);
}

const argv = yargs(hideBin(process.argv))
  .option('dir', { type: 'string', describe: 'Directory tree of PDFs to ingest' })
  .option('slug', { type: 'string', demandOption: true, describe: 'Target data lake slug' })
  .option('userId', { type: 'string', demandOption: true, describe: 'FabFile owner (lake creator or admin)' })
  .option('organizationId', { type: 'string', describe: 'Charge storage to this org instead of the user' })
  .option('concurrency', {
    type: 'number',
    default: 4,
    describe: 'Parallel uploads, clamped to 1-8 (drives objectCreated lambda concurrency)',
  })
  .option('limit', { type: 'number', describe: 'Upload at most N files (smoke tests)' })
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('status', { type: 'boolean', default: false, describe: 'Read-only pipeline progress report' })
  .option('requeue-stragglers', {
    type: 'boolean',
    default: false,
    describe: 'Re-enqueue complete-but-unchunked lake files',
  })
  .option('requeue-limit', { type: 'number', default: 50, describe: 'Max stragglers to re-enqueue per run' })
  .parseSync();

main({
  dir: argv.dir,
  slug: argv.slug,
  userId: argv.userId,
  organizationId: argv.organizationId,
  concurrency: argv.concurrency,
  limit: argv.limit,
  execute: argv.execute,
  status: argv.status,
  requeueStragglers: argv['requeue-stragglers'],
  requeueLimit: argv['requeue-limit'],
})
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
