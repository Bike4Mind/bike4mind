import { SPEND_BUCKET_MS, floorToBucket } from '@bike4mind/common';

/** A bucket is rolled up only after this long past its end, so late-settling transactions are included. */
const SETTLEMENT_GRACE_MS = 2 * 60 * 1000;
const MAX_CATCH_UP_BUCKETS = 24;

/**
 * Closed buckets (start + bucket + grace <= now) newer than `latestRolled`, ascending, capped to the
 * newest 24 so a long outage does not turn into an unbounded backfill.
 */
export function bucketsToRoll(now: Date, latestRolled: Date | null): Date[] {
  const closedBucketMs = SPEND_BUCKET_MS + SETTLEMENT_GRACE_MS;
  const newestClosed = floorToBucket(new Date(now.getTime() - closedBucketMs)).getTime();
  const oldestWanted = newestClosed - (MAX_CATCH_UP_BUCKETS - 1) * SPEND_BUCKET_MS;
  const firstUnrolled = latestRolled ? latestRolled.getTime() + SPEND_BUCKET_MS : newestClosed;
  const first = Math.max(firstUnrolled, oldestWanted);

  const buckets: Date[] = [];
  for (let start = first; start <= newestClosed; start += SPEND_BUCKET_MS) {
    buckets.push(new Date(start));
  }
  return buckets;
}
