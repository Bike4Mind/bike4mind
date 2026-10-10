#!/usr/bin/env tsx

/**
 * Turn on the per-answer credit cost chip (User.showCreditsUsed) for existing users. Logic:
 * ./backfillShowCreditsUsed.ts.
 *
 * Dry run by default; pass --execute to write. By default only users with no stored value are
 * touched; --include-false also flips stored `false`, which overrides any deliberate opt-out.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:show-credits-used [--include-false]
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:show-credits-used [--include-false] --execute
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { backfillShowCreditsUsed } from './backfillShowCreditsUsed';

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const includeFalse = process.argv.includes('--include-false');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  await backfillShowCreditsUsed({ dryRun, includeFalse });
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-show-credits-used] failed:', error);
  process.exit(1);
});
