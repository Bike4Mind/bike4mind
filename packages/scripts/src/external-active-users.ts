#!/usr/bin/env tsx

/**
 * Read-only report of external DAU and weekly cohort retention. Definition, exclusions and flags:
 * ./externalActiveUsers.ts (or pass --help).
 *
 * Usage (inside an SST shell so the Mongo URI resolves; set the staff domains explicitly, the shell
 * does not carry them):
 *   NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS=example.com,example.org \
 *     npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts report:external-active-users
 *   ... report:external-active-users --days 60 --test-pattern '\+(e2e|test|qa)'
 */

import { HELP_TEXT, parseReportArgs } from './externalActiveUsers';

async function main() {
  const { help, days, testPattern } = parseReportArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
    return;
  }

  // Loaded after arg parsing: the SST resources and config throw outside an SST shell, and --help
  // and bad flags should not need one. The db-core connectDB, not the @bike4mind/database one: that
  // wrapper seeds the model catalog and price rows on connect, which a read-only report must not do.
  const { connectDB } = await import('@bike4mind/db-core');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const { runExternalActivityReport } = await import('./externalActiveUsersReport');

  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));
  await runExternalActivityReport({ days, testPattern });
  process.exit(0);
}

main().catch(error => {
  console.error('[external-active-users] failed:', error);
  process.exit(1);
});
