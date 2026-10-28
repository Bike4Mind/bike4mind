import { mongoose } from '@bike4mind/database';
import {
  stripeMirrorFields,
  type StripeSubscriptionMirrorSource,
} from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';

/** Reads one subscription from Stripe; null when Stripe no longer has it. Must never write. */
export type RetrieveStripeSubscription = (subscriptionId: string) => Promise<StripeSubscriptionMirrorSource | null>;

export interface BackfillSubscriptionStripeMirrorOptions {
  dryRun: boolean;
  /** Re-sync rows that already carry the mirror, not only rows that lack it. */
  resync: boolean;
  retrieve: RetrieveStripeSubscription;
  log?: (message: string) => void;
}

export interface BackfillSubscriptionStripeMirrorResult {
  scanned: number;
  updated: number;
  missingInStripe: number;
  failed: number;
}

/**
 * Writes the Stripe mirror fields (stripeMirrorFields) onto Stripe-managed Subscription rows, one
 * Stripe read per row. Stripe is only read; Mongo is the only thing written. By default only rows
 * without `lastSyncedAt` are touched, so a re-run picks up where a failed one stopped and is
 * otherwise a no-op. A row whose Stripe read fails is counted and skipped, never guessed at.
 */
export async function backfillSubscriptionStripeMirror(
  options: BackfillSubscriptionStripeMirrorOptions
): Promise<BackfillSubscriptionStripeMirrorResult> {
  const { dryRun, resync, retrieve, log = console.log } = options;
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');

  // The raw collection, not the model: the model lives in apps/client, and Mongoose would bump
  // updatedAt on every row, which is not a change to the subscription.
  const subscriptions = db.collection('subscriptions');
  const filter = resync ? { source: 'stripe' } : { source: 'stripe', lastSyncedAt: { $exists: false } };
  const result: BackfillSubscriptionStripeMirrorResult = { scanned: 0, updated: 0, missingInStripe: 0, failed: 0 };

  for await (const row of subscriptions.find(filter, { projection: { subscriptionId: 1 } })) {
    result.scanned += 1;
    const subscriptionId: unknown = row.subscriptionId;
    if (typeof subscriptionId !== 'string') {
      log(`[backfill-subscription-stripe-mirror] row ${row._id} has no subscriptionId, skipping`);
      result.failed += 1;
      continue;
    }

    try {
      const subscription = await retrieve(subscriptionId);
      if (!subscription) {
        log(`[backfill-subscription-stripe-mirror] ${subscriptionId} not found in Stripe, skipping`);
        result.missingInStripe += 1;
        continue;
      }
      if (!dryRun) await subscriptions.updateOne({ _id: row._id }, { $set: stripeMirrorFields(subscription) });
      result.updated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[backfill-subscription-stripe-mirror] ${subscriptionId} failed: ${message}`);
      result.failed += 1;
    }
  }

  log(
    `[backfill-subscription-stripe-mirror] scanned ${result.scanned}, ${dryRun ? 'would update' : 'updated'} ` +
      `${result.updated}, missing in Stripe ${result.missingInStripe}, failed ${result.failed}`
  );
  return result;
}
