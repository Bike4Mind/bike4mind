#!/usr/bin/env tsx

/**
 * One-off audit for credit purchases left with a ledger row but no balance increment, from before
 * the purchase grant became one transaction. Verdict rules: ./auditPartialCreditPurchases.ts.
 *
 * Dry run by default; it still reads Stripe to check each ungranted intent. Pass --apply to credit
 * the ungranted purchases Stripe backs. Refunded, disputed and unverifiable purchases are only
 * reported: resolve those by hand. Re-runs are safe; a repaired row is marked and skipped.
 *
 * Run it only once the transactional purchase grant is live on the stage: against the old
 * two-write grant, a webhook caught between its row and its increment reads as ungranted, and
 * --apply would credit it alongside the increment that is about to land.
 *
 * Flags:
 *   --stamp-since <iso>    required, UTC, e.g. 2026-09-25T10:00:00Z: when the reliable purchase stamp
 *                          reached this stage (deploy time of the change behind
 *                          RELIABLE_PURCHASE_STAMP_MERGED_AT)
 *   --apply                write the repairs
 *   --report <path>        write every audited purchase to a JSON file. It holds user and payment
 *                          intent ids, so keep it outside the repo.
 *
 * Usage (inside an SST shell so the Mongo URI and Stripe key resolve):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts audit:partial-credit-purchases \
 *     --stamp-since <iso> --report /tmp/audit.json [--apply]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import Stripe from 'stripe';
import { Config } from '../utils/config';
import {
  auditPartialCreditPurchases,
  describePaymentIntentProblem,
  type AuditedPurchase,
  type PurchaseVerdict,
} from './auditPartialCreditPurchases';

// Strict: an unknown or malformed flag (say, --apply=true) fails instead of running as something else.
function parseFlags() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      report: { type: 'string' },
      'stamp-since': { type: 'string' },
    },
    strict: true,
  });
  const rawStampSince = values['stamp-since'];
  if (rawStampSince === undefined) throw new Error('--stamp-since <iso> is required (UTC, e.g. 2026-09-25T10:00:00Z)');
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(rawStampSince)) {
    throw new Error(`--stamp-since needs an explicit UTC offset (e.g. 2026-09-25T10:00:00Z): ${rawStampSince}`);
  }
  const stampSince = new Date(rawStampSince);
  if (Number.isNaN(stampSince.getTime())) throw new Error(`--stamp-since is not a date: ${rawStampSince}`);
  // pnpm runs the script from the package directory; resolve against where the operator stood.
  const reportPath = values.report && resolve(process.env.INIT_CWD ?? process.cwd(), values.report);
  return { apply: values.apply, reportPath, stampSince };
}

function describe(purchase: AuditedPurchase): string {
  const outcome = purchase.repairError
    ? `REPAIR FAILED: ${purchase.repairError}`
    : purchase.repaired
      ? 'repaired'
      : (purchase.paymentIntentProblem ?? 'Stripe backs a repair');
  return `  ${purchase.paymentIntentId} user=${purchase.ownerId} credits=${purchase.credits} at=${purchase.createdAt} -> ${outcome}`;
}

async function main() {
  const { apply, reportPath, stampSince } = parseFlags();
  const stage = Resource.App.stage;

  await connectDB((process.env.MONGODB_URI ?? Config.MONGODB_URI).replace('%STAGE%', stage));
  const stripe = new Stripe(Config.STRIPE_SECRET_KEY);

  console.log(`Stage: ${stage}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);

  const { purchases } = await auditPartialCreditPurchases({
    apply,
    stampSince,
    checkPaymentIntent: async (paymentIntentId, credits) => {
      try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
        return describePaymentIntentProblem(intent, stage, credits);
      } catch (error) {
        // An intent Stripe cannot return (e.g. created under another key) blocks only its own repair.
        return `Stripe lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const counts = new Map<PurchaseVerdict, number>();
  for (const purchase of purchases) counts.set(purchase.verdict, (counts.get(purchase.verdict) ?? 0) + 1);
  console.log(`Audited ${purchases.length} purchase row(s):`, Object.fromEntries(counts));

  const ungranted = purchases.filter(purchase => purchase.verdict === 'ungranted');
  console.log(`Ungranted (${ungranted.length}):`);
  ungranted.forEach(purchase => console.log(describe(purchase)));

  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(purchases, null, 2));
    console.log(`Full report (including unverifiable rows): ${reportPath}`);
  }
  if (!apply && ungranted.some(purchase => purchase.paymentIntentProblem === null)) {
    console.log('Dry run only. Re-run with --apply to credit the purchases Stripe backs.');
  }
  process.exit(ungranted.some(purchase => purchase.repairError) ? 1 : 0);
}

main().catch(error => {
  console.error('[audit-partial-credit-purchases] failed:', error);
  process.exit(1);
});
