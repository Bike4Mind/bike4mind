#!/usr/bin/env tsx

/**
 * Stamp the owning organization on existing FabFiles that belong to an org-owned lake. Logic and
 * the owner rule: ./backfillFabFileOwnerOrganization.ts.
 *
 * Dry run by default (prints counts plus every ambiguous and conflicting row); pass --execute to
 * write. Safe to re-run.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:fabfile-owner-organization
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:fabfile-owner-organization --execute
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { backfillFabFileOwnerOrganization } from './backfillFabFileOwnerOrganization';

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  await backfillFabFileOwnerOrganization({ dryRun });
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-fabfile-owner-organization] failed:', error);
  process.exit(1);
});
