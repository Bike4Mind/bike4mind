#!/usr/bin/env tsx

/**
 * Backfill the analytics rollup tables (analytics_user_days, analytics_daily) from usageevents, one
 * UTC day at a time. Logic and idempotency notes: ./backfillAnalyticsRollup.ts.
 *
 * Dry run by default; pass --execute to write. Days that already have a daily row are skipped
 * unless --force is passed, so an interrupted run resumes where it stopped.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:analytics-rollup --from 2026-01-01 --to 2026-03-31
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:analytics-rollup --execute
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { backfillAnalyticsRollup } from './backfillAnalyticsRollup';

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  await backfillAnalyticsRollup({
    dryRun,
    from: flagValue('--from'),
    to: flagValue('--to'),
    force: process.argv.includes('--force'),
  });
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-analytics-rollup] failed:', error);
  process.exit(1);
});
