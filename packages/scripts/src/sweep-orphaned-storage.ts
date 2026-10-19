#!/usr/bin/env tsx

/**
 * Sweep storage that FabFile deletes and text AI edits left behind before they cleaned up after
 * themselves. Logic and safety notes: ./sweepOrphanedStorage.ts.
 *
 *   --versions        retained-version objects of user-deleted files (rows are left as they are)
 *   --backups         legacy files/<userId>/backups/ keys
 *   --older-than <n>  backup age cutoff in days (default 30)
 *   --apply           delete; without it this is a dry run that only reports counts and bytes
 * With neither --versions nor --backups, both passes run.
 *
 * On a stage with ENABLE_BUCKET_VERSIONING on, a delete only adds a delete marker: the bytes go
 * when the bucket's noncurrent-version lifecycle rule expires them (infra/buckets.ts), not now.
 *
 * Usage (inside an SST shell so the Mongo URI and bucket resolve; dry run first):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts sweep:orphaned-storage
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts sweep:orphaned-storage --apply
 */

import { connectDB } from '@bike4mind/database';
import { createS3Client } from '@bike4mind/fab-pipeline';
import mongoose from 'mongoose';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import {
  assertBucketReachable,
  parseSweepArgs,
  s3SweepAdapters,
  sweepLegacyBackups,
  sweepOrphanedVersions,
} from './sweepOrphanedStorage';

async function main() {
  const args = parseSweepArgs(process.argv.slice(2));
  const dryRun = !args.apply;
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));
  const bucket = Resource.fabFileBucket.name;
  // Same addressing as S3Storage: a custom endpoint (self-host MinIO) is path-style.
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  const client = createS3Client({
    region: process.env.AWS_REGION || 'us-east-2',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  await assertBucketReachable(client, bucket);
  const { storage, lister } = s3SweepAdapters(client, bucket);

  // The DB and the bucket resolve independently; print both so a stage mismatch is visible.
  console.log(`Mode: ${dryRun ? 'DRY RUN (no deletes)' : 'APPLY'}, db: ${mongoose.connection.name}, bucket: ${bucket}`);
  if (args.versions) {
    const r = await sweepOrphanedVersions({ dryRun, storage });
    console.log(
      `versions - rows: ${r.rows}, keys: ${r.keys}, bytes: ${r.bytes}, skipped (current file present): ` +
        `${r.skippedPresent}, skipped (HEAD error): ${r.skippedHeadError}, skipped (no filePath): ` +
        `${r.skippedNoFilePath}, skipped (referenced): ${r.skippedReferenced}, delete failures: ${r.deleteFailures}`
    );
  }
  if (args.backups) {
    const r = await sweepLegacyBackups({ dryRun, olderThanDays: args.olderThanDays, lister, storage });
    console.log(
      `backups (older than ${args.olderThanDays}d) - users: ${r.users}, keys: ${r.keys}, bytes: ${r.bytes}, ` +
        `skipped (young): ${r.skippedYoung}, skipped (referenced): ${r.skippedReferenced}, delete failures: ${r.deleteFailures}`
    );
  }
  if (dryRun) console.log('Dry run only. Re-run with --apply to delete.');
  process.exit(0);
}

main().catch(error => {
  console.error('[sweep-orphaned-storage] failed:', error);
  process.exit(1);
});
