#!/usr/bin/env tsx

/**
 * One-off migration of accounts that are still mid-drip onto the live signup grant schedule, from what
 * they have received. Flat-grant accounts are untouched. Selector, exclusions and idempotency notes:
 * ./migrateSignupGrantSchedule.ts.
 *
 * Dry run by default. Run report-signup-grant-sizing.ts first and get the dry-run output approved before
 * any --apply. --apply needs --max-users and --max-credits: it refuses to write when more accounts change,
 * or could still drip more credits in total, than those caps. Every run first records the planned changes
 * (user id, before, after) to --report <path> (default: a timestamped JSON file in the OS temp dir; created
 * with mode 0600, never overwriting), so a change can be traced and restored.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts migrate:signup-grant-schedule
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts migrate:signup-grant-schedule --apply --max-users 200 --max-credits 1000000
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { migrateSignupGrantSchedule, parseMigrationArgs } from './migrateSignupGrantSchedule';

async function main() {
  const options = parseMigrationArgs(process.argv);
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  await migrateSignupGrantSchedule(options);
  if (!options.apply) console.log('Dry run only. Re-run with --apply --max-users <n> --max-credits <n> to write.');
  process.exit(0);
}

main().catch(error => {
  console.error('[migrate-signup-grant-schedule] failed:', error);
  process.exit(1);
});
