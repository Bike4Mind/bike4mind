#!/usr/bin/env tsx

/**
 * Clear the paid-standing stamp (User.lastCreditsPurchasedAt) from users no completed, unreversed
 * purchase or active subscription backs. Logic: ./reconcilePurchaseStamps.ts.
 *
 * Reads Stripe for each completed, unreversed purchase row with a payment intent: a full refund or a lost dispute marks the row
 * reversed. A row whose owner is missing is matched to a user through the payment intent's
 * customer and only reported, never rewritten; if any stays unmatched, --apply refuses to write.
 *
 * Flags:
 *   --apply           write (default is a dry run that changes nothing)
 *   --report=<path>   also write the verdicts as JSON; must be an absolute path outside the repo
 * Exit: 0 clean, 1 when a Stripe or subscription read failed (those users were kept),
 *       2 on a bad flag or when --apply stopped on an unmatched purchase row.
 *
 * Usage (inside an SST shell so the Mongo URI, Stripe key and websocket endpoint resolve; dry run first):
 *   npx sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts credits:reconcile-purchase-stamps [--report=/abs/path]
 *   npx sst shell --stage <stage> -- pnpm --filter @bike4mind/scripts credits:reconcile-purchase-stamps --apply [--report=/abs/path]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectDB } from '@bike4mind/database';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';
import Stripe from 'stripe';
import { Config } from '../utils/config';
import { reconcilePurchaseStamps } from './reconcilePurchaseStamps';
import { createStripeLookups, resolveReportPath } from './reconcilePurchaseStampsStripe';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Same keys purchaseReversal.ts (apps/client/server/billing) invalidates on a revocation.
const INVALIDATED_QUERY_KEYS = [['llm', 'models'], ['entitlements']];

async function main() {
  // Strict: an unknown or malformed flag fails instead of running as something else.
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      report: { type: 'string' },
    },
    strict: true,
  });

  let reportPath: string | null = null;
  if (values.report !== undefined) {
    try {
      reportPath = resolveReportPath(values.report, REPO_ROOT);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  }

  let endpoint = '';
  if (values.apply) {
    try {
      endpoint = Resource.websocket.managementEndpoint;
    } catch {
      endpoint = '';
    }
    if (!endpoint) {
      console.error('--apply needs the websocket endpoint; run inside an SST shell for the stage');
      process.exit(2);
    }
  }

  await connectDB((process.env.MONGODB_URI ?? Config.MONGODB_URI).replace('%STAGE%', Resource.App.stage));
  const stripe = new Stripe(Config.STRIPE_SECRET_KEY);

  console.log(`Mode: ${values.apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  const result = await reconcilePurchaseStamps({
    apply: values.apply,
    ...createStripeLookups(stripe),
    notify: userId =>
      Promise.allSettled(
        INVALIDATED_QUERY_KEYS.map(queryKey => sendToClient(userId, endpoint, { action: 'invalidate_query', queryKey }))
      ),
  });

  const counts = { keep: 0, clear: 0 };
  for (const user of result.users) counts[user.verdict]++;
  console.log(
    `Stamped users: ${result.users.length} (keep ${counts.keep}, ${values.apply ? 'cleared' : 'would clear'} ${counts.clear}); ` +
      `reversals: ${result.reversals.length}; ownerless rows: ${result.ownerless.length}; errors: ${result.errors.length}`
  );
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(`Report written to ${reportPath}`);
  }
  if (!values.apply) console.log('Dry run only. Re-run with --apply to write.');
  process.exit(result.aborted ? 2 : result.errors.length > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('[reconcile-purchase-stamps] failed:', error);
  process.exit(1);
});
