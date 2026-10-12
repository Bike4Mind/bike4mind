#!/usr/bin/env tsx

/**
 * One-off audit for credit purchases left with a ledger row but no balance increment, from before
 * the purchase grant became one transaction. Verdict rules: ./auditPartialCreditPurchases.ts.
 *
 * Dry run by default; it still reads Stripe to check each ungranted intent. Pass --apply to credit
 * the ungranted purchases Stripe backs. Refunded, disputed and unverifiable purchases are only
 * reported: resolve those by hand. Re-runs are safe; a repaired row is marked and skipped.
 *
 * Flags:
 *   --apply                write the repairs
 *   --report <path>        write every audited purchase to a JSON file
 *   --stamp-since <iso>    override the lastCreditsPurchasedAt cutoff derived from the data
 *
 * Usage (inside an SST shell so the Mongo URI and Stripe key resolve):
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts audit:partial-credit-purchases --report audit.json
 *   npx sst shell --stage <stage> pnpm --filter @bike4mind/scripts audit:partial-credit-purchases --apply --report audit.json
 */

import { writeFileSync } from 'node:fs';
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

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function parseStampSince(): Date | undefined {
  const raw = flagValue('--stamp-since');
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`--stamp-since is not a date: ${raw}`);
  return date;
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
  const apply = process.argv.includes('--apply');
  const reportPath = flagValue('--report');
  const stampSince = parseStampSince();
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
