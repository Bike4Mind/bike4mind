#!/usr/bin/env tsx

/**
 * Backfill the 5-minute SpendRollup buckets so the spend monitor has spike baselines from day one.
 * Logic: ./backfillSpendRollups.ts. Safe to re-run; each bucket is rewritten in place.
 *
 * Usage (inside an SST shell so the Mongo URI resolves):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:spend-rollups
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts backfill:spend-rollups --days 7
 */

import { connectDB, spendRollupRepository } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { backfillSpendRollups } from './backfillSpendRollups';

const DEFAULT_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;
// A bucket [t, t+5m) is closed at t+7m (the cron's 2-minute settlement grace), so stop at now - 7m.
const CLOSED_BUCKET_LAG_MS = 7 * 60 * 1000;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const parseDays = (): number => {
  const raw = flagValue('--days');
  if (raw === undefined) return DEFAULT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`--days must be a positive integer, got "${raw}"`);
  }
  return days;
};

async function main() {
  const days = parseDays();
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  const to = new Date(Date.now() - CLOSED_BUCKET_LAG_MS);
  const from = new Date(to.getTime() - days * DAY_MS);
  console.log(`Backfilling spend rollups from ${from.toISOString()} to ${to.toISOString()} (${days} days)`);

  const buckets = await backfillSpendRollups(spendRollupRepository, from, to, (done, total) =>
    console.log(`Rolled up ${done}/${total} buckets`)
  );
  console.log(`Done: ${buckets} buckets.`);
  process.exit(0);
}

main().catch(error => {
  console.error('[backfill-spend-rollups] failed:', error);
  process.exit(1);
});
