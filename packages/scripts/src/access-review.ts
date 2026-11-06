#!/usr/bin/env tsx

/**
 * Read-only quarterly access review snapshot. Options: ./accessReviewArgs.ts (or pass --help).
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage production pnpm --filter @bike4mind/scripts report:access-review \
 *     --out review.md --json before.json [--baseline before.json] [--all-keys]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP_TEXT, parseAccessReviewArgs } from './accessReviewArgs';

// pnpm runs the script from the package directory; resolve against where the operator stood.
const operatorPath = (file: string) => resolve(process.env.INIT_CWD ?? process.cwd(), file);
// Owner-only: the report and snapshot name real accounts.
const PRIVATE_FILE = { mode: 0o600 };

async function main() {
  const { help, out, json, baseline, allKeys } = parseAccessReviewArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
    return;
  }

  const { formatAccessReviewMarkdown, parseAccessReviewBaseline } =
    await import('@bike4mind/server-utils/security/accessReview/accessReview');
  // Read before connecting so a bad baseline fails without touching the database.
  const before = baseline
    ? parseAccessReviewBaseline(JSON.parse(readFileSync(operatorPath(baseline), 'utf8')))
    : undefined;

  // The db-core connectDB, not the @bike4mind/database one, which seeds catalog rows on connect;
  // autoIndex and autoCreate off so a checkout ahead of the stage builds no indexes.
  const { connectDB } = await import('@bike4mind/db-core');
  const { Resource } = await import('sst');
  const { Config } = await import('../utils/config');
  const { collectAccessReview } = await import('@bike4mind/server-utils/security/accessReview/accessReviewData');

  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false, autoCreate: false });
  const snapshot = await collectAccessReview({ allApiKeys: allKeys });
  const markdown = formatAccessReviewMarkdown(snapshot, before);

  if (json) {
    writeFileSync(operatorPath(json), `${JSON.stringify(snapshot, null, 2)}\n`, PRIVATE_FILE);
    console.log(`Snapshot written to ${operatorPath(json)}`);
  }
  if (out) {
    writeFileSync(operatorPath(out), `${markdown}\n`, PRIVATE_FILE);
    console.log(`Report written to ${operatorPath(out)}`);
  } else {
    console.log(markdown);
  }
  process.exit(0);
}

main().catch(error => {
  console.error('[access-review] failed:', error);
  process.exit(1);
});
