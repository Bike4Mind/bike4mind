#!/usr/bin/env tsx

/**
 * Backfill Session.imageCount from the images already stored on each session's quests, so
 * notebooks created before the counter shipped get the sidebar's image marker and match the
 * "Images" filter. Logic and idempotency notes: ./backfillSessionImageCount.ts.
 *
 * Dry run by default; pass --execute to write.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:session-image-count
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:session-image-count --execute
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { backfillSessionImageCounts } from './backfillSessionImageCount';

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  await backfillSessionImageCounts({ dryRun });
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-session-image-count] failed:', error);
  process.exit(1);
});
