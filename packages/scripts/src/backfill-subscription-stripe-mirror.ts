#!/usr/bin/env tsx

/**
 * Backfill the Stripe mirror fields (price, currency, interval, cancel state, trial end, customer)
 * onto Stripe-managed Subscription rows. Logic: ./backfillSubscriptionStripeMirror.ts.
 *
 * Read-only against Stripe (subscriptions.retrieve per row); writes Mongo only. Dry run by default,
 * which still reads Stripe; pass --execute to write. By default only rows never synced are touched;
 * --resync refreshes every Stripe-managed row. Exits 1 when any row failed, so a re-run is due.
 *
 * Usage (inside an SST shell so the Mongo URI and Stripe key resolve):
 *   npx sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts backfill:subscription-stripe-mirror [--resync]
 *   npx sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts backfill:subscription-stripe-mirror [--resync] --execute
 */

import { parseArgs } from 'node:util';
import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import Stripe from 'stripe';
import { Config } from '../utils/config';
import { backfillSubscriptionStripeMirror, retrieveFromStripe } from './backfillSubscriptionStripeMirror';

async function main() {
  // Strict: an unknown or malformed flag fails instead of running as something else.
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      resync: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const dryRun = !values.execute;

  await connectDB((process.env.MONGODB_URI ?? Config.MONGODB_URI).replace('%STAGE%', Resource.App.stage));
  const stripe = new Stripe(Config.STRIPE_SECRET_KEY);

  console.log(`Mode: ${dryRun ? 'DRY RUN (no Mongo writes)' : 'EXECUTE'}${values.resync ? ', resync all' : ''}`);
  const result = await backfillSubscriptionStripeMirror({
    dryRun,
    resync: values.resync,
    retrieve: retrieveFromStripe(stripe),
  });
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('[backfill-subscription-stripe-mirror] failed:', error);
  process.exit(1);
});
