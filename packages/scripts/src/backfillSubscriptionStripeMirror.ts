import { mongoose } from '@bike4mind/database';
import {
  stripeMirrorFields,
  type StripeSubscriptionMirrorSource,
} from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import Stripe from 'stripe';

/** Reads one subscription from Stripe; null when Stripe no longer has it. Must never write. */
export type RetrieveStripeSubscription = (subscriptionId: string) => Promise<StripeSubscriptionMirrorSource | null>;

type StripeSubscriptionReader = {
  subscriptions: { retrieve: (subscriptionId: string) => Promise<StripeSubscriptionMirrorSource> };
};

/** `subscriptions.retrieve`, with Stripe's "no such subscription" mapped to null. */
export const retrieveFromStripe =
  (stripe: StripeSubscriptionReader): RetrieveStripeSubscription =>
  async subscriptionId => {
    try {
      return await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') return null;
      throw error;
    }
  };

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
  /** Rows another sync (a webhook) rewrote after the scan read them; left as that sync wrote them. */
  skippedNewer: number;
  missingInStripe: number;
  failed: number;
}

/**
 * Writes the Stripe mirror fields (stripeMirrorFields) onto Stripe-managed Subscription rows, one
 * Stripe read per row. Stripe is only read; Mongo is the only thing written. By default only rows
 * without `lastSyncedAt` are touched, so a re-run picks up where a failed one stopped and is
 * otherwise a no-op. A row whose Stripe read fails is counted and skipped, never guessed at. The
 * write is a compare-and-set on the `lastSyncedAt` the scan read, so a sync written after the scan
 * (a webhook landing during the Stripe read) is never overwritten, whatever either side's clock says.
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
  const result: BackfillSubscriptionStripeMirrorResult = {
    scanned: 0,
    updated: 0,
    skippedNewer: 0,
    missingInStripe: 0,
    failed: 0,
  };

  for await (const row of subscriptions.find(filter, { projection: { subscriptionId: 1, lastSyncedAt: 1 } })) {
    result.scanned += 1;
    const subscriptionId: unknown = row.subscriptionId;
    if (typeof subscriptionId !== 'string') {
      log(`[backfill-subscription-stripe-mirror] row ${row._id} has no subscriptionId, skipping`);
      result.failed += 1;
      continue;
    }

    try {
      const readAt = new Date();
      const subscription = await retrieve(subscriptionId);
      if (!subscription) {
        log(`[backfill-subscription-stripe-mirror] ${subscriptionId} not found in Stripe, skipping`);
        result.missingInStripe += 1;
        continue;
      }
      if (dryRun) {
        result.updated += 1;
        continue;
      }
      const scannedSyncedAt: unknown = row.lastSyncedAt;
      const unchangedSinceScan =
        scannedSyncedAt === undefined ? { lastSyncedAt: { $exists: false } } : { lastSyncedAt: scannedSyncedAt };
      const { matchedCount } = await subscriptions.updateOne(
        { _id: row._id, ...unchangedSinceScan },
        { $set: stripeMirrorFields(subscription, readAt) }
      );
      if (matchedCount) result.updated += 1;
      else result.skippedNewer += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[backfill-subscription-stripe-mirror] ${subscriptionId} failed: ${message}`);
      result.failed += 1;
    }
  }

  log(
    `[backfill-subscription-stripe-mirror] scanned ${result.scanned}, ${dryRun ? 'would update' : 'updated'} ` +
      `${result.updated}, skipped as newer ${result.skippedNewer}, missing in Stripe ${result.missingInStripe}, failed ${result.failed}`
  );
  return result;
}
