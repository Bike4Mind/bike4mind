#!/usr/bin/env tsx

/**
 * Read-only gear grant audit: payouts per gear and per account, accounts that claimed every gear
 * soon after signup, the share of gear credits spent on frontier models, and what the data shows of
 * the claim checks. Definitions: ./gearGrantAudit.ts (or pass --help).
 *
 * Usage (inside an SST shell so the Mongo URI resolves; set the staff domains explicitly, the shell
 * does not carry them):
 *   NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS=example.com \
 *     npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts report:gear-grant-audit [--days 30] [--out /tmp/gears.md]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP_TEXT, parseGearAuditArgs } from './gearGrantAudit';

async function main() {
  const { help, out, ...options } = parseGearAuditArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
    return;
  }

  // Loaded after arg parsing so --help and bad flags need no SST shell. The db-core connectDB, not the
  // @bike4mind/database one, which seeds catalog rows on connect; autoIndex and autoCreate off so a
  // checkout ahead of the stage builds no indexes.
  const { connectDB } = await import('@bike4mind/db-core');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const { runGearGrantAudit } = await import('./gearGrantAuditData');

  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false, autoCreate: false });
  const { markdown } = await runGearGrantAudit(options);
  if (out) {
    // pnpm runs the script from the package directory; resolve against where the operator stood.
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), out);
    writeFileSync(path, `${markdown}\n`);
    console.log(`Report written to ${path}`);
  } else {
    console.log(markdown);
  }
  process.exit(0);
}

main().catch(error => {
  console.error('[gear-grant-audit] failed:', error);
  process.exit(1);
});
