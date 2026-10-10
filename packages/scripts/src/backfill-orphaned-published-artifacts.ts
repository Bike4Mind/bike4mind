#!/usr/bin/env tsx

/**
 * Soft-delete published artifacts whose owner account no longer exists (deleted before account
 * deletion started purging them). Logic and idempotency notes: ./backfillOrphanedPublishedArtifacts.ts.
 *
 * Dry run by default; pass --execute to write.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:orphaned-published-artifacts
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:orphaned-published-artifacts --execute
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { backfillOrphanedPublishedArtifacts } from './backfillOrphanedPublishedArtifacts';

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  await backfillOrphanedPublishedArtifacts({ dryRun });
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-orphaned-published-artifacts] failed:', error);
  process.exit(1);
});
