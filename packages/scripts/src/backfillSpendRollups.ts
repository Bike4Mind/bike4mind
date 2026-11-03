import { floorToBucket, SPEND_BUCKET_MS, type ISpendRollupRepository } from '@bike4mind/common';

const BUCKETS_PER_PROGRESS_REPORT = 288;
const DEFAULT_BACKFILL_DAYS = 28;

/** Reads `--days N` from argv: 28 when the flag is absent, and a thrown error for a flag without a positive integer. */
export function parseBackfillDays(argv: string[]): number {
  const index = argv.indexOf('--days');
  if (index === -1) return DEFAULT_BACKFILL_DAYS;
  const raw = argv[index + 1];
  const days = Number(raw);
  if (raw === undefined || !Number.isInteger(days) || days < 1) {
    throw new Error(`--days must be a positive integer, got "${raw ?? ''}"`);
  }
  return days;
}

/**
 * Rolls up every 5-minute bucket in [floorToBucket(from), floorToBucket(to)), oldest first, via the
 * same repository call the spendMonitor cron uses. Idempotent: rollupBucket rewrites a bucket's rows
 * in place, so an interrupted run can simply be repeated. Returns the number of buckets processed.
 */
export async function backfillSpendRollups(
  repo: Pick<ISpendRollupRepository, 'rollupBucket'>,
  from: Date,
  to: Date,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const firstBucketMs = floorToBucket(from).getTime();
  const endMs = floorToBucket(to).getTime();
  const total = Math.max(0, Math.ceil((endMs - firstBucketMs) / SPEND_BUCKET_MS));

  for (let done = 0; done < total; done++) {
    await repo.rollupBucket(new Date(firstBucketMs + done * SPEND_BUCKET_MS));
    const completed = done + 1;
    if (completed % BUCKETS_PER_PROGRESS_REPORT === 0 || completed === total) {
      onProgress?.(completed, total);
    }
  }
  return total;
}
