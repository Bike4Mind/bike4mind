#!/usr/bin/env tsx

/**
 * One-off repair for users whose `organizationId` points at an org that is missing, soft-deleted,
 * or no longer counts them as a member (a managerId-only manager included). Selector and
 * idempotency notes: ./clearStaleOrganizationPointers.ts.
 *
 * Dry run by default; pass --apply to write. Every run first records the stale pointers (org, reason,
 * user ids) to --report <path> (default: a timestamped JSON file in the cwd), so a nulled pointer can
 * be traced and restored. The deleteOrganization fix must be deployed first,
 * or org deletes keep creating new stale pointers after the run.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts repair:stale-organization-pointers
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts repair:stale-organization-pointers --apply
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { clearStaleOrganizationPointers } from './clearStaleOrganizationPointers';

async function main() {
  const apply = process.argv.includes('--apply');
  const reportFlag = process.argv.indexOf('--report');
  const reportPath =
    reportFlag === -1 ? `stale-organization-pointers-${Date.now()}.json` : process.argv[reportFlag + 1];
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  await clearStaleOrganizationPointers({ apply, reportPath });
  if (!apply) console.log('Dry run only. Re-run with --apply to null the stale pointers.');
  process.exit(0);
}

main().catch(error => {
  console.error('[repair-stale-organization-pointers] failed:', error);
  process.exit(1);
});
