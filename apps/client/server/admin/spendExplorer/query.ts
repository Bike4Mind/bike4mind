import { createHash } from 'node:crypto';
import {
  SPEND_BUCKET_SIZES,
  SPEND_EXPLORER_MAX_ACCOUNTS,
  SPEND_EXPLORER_MAX_RANGE_DAYS,
  SPEND_SPLIT_DIMENSIONS,
  type SpendBucketSize,
} from '@bike4mind/common';
import { z } from 'zod';
import { ceilToBucket, floorToBucket } from './shapeTimeline';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ranges of this many days or fewer default to hourly buckets. */
export const HOURLY_AUTO_MAX_DAYS = 3;

const isoDate = z
  .string()
  .refine(v => !Number.isNaN(new Date(v).getTime()), 'must be an ISO-8601 date')
  .transform(v => new Date(v));

// Only the literal "true" busts the cache (z.coerce.boolean would treat "false" as truthy).
const recache = z
  .string()
  .optional()
  .transform(v => v === 'true');

const isDate = (value: unknown): value is Date => value instanceof Date;

// Object-level refinements still run when a field already failed, so guard the parsed types.
const orderedRange = (q: { from: unknown; to: unknown }) => isDate(q.from) && isDate(q.to) && q.from < q.to;

export const TimelineQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    bucket: z.enum(SPEND_BUCKET_SIZES).optional(),
    splitBy: z.enum(SPEND_SPLIT_DIMENSIONS).default('provider'),
    // The acting user (UsageEvent.userId), whoever paid.
    userId: z.string().min(1).max(64).optional(),
    recache,
  })
  .refine(orderedRange, { message: 'from must be before to', path: ['from'] })
  .transform(q => {
    const days = (q.to.getTime() - q.from.getTime()) / DAY_MS;
    const bucket: SpendBucketSize = q.bucket ?? (days <= HOURLY_AUTO_MAX_DAYS ? 'hour' : 'day');
    // Snap to whole UTC buckets so every bucket is complete and keys line up with the aggregation.
    return { ...q, bucket, from: floorToBucket(q.from, bucket), to: ceilToBucket(q.to, bucket) };
  })
  .refine(q => q.to.getTime() - q.from.getTime() <= SPEND_EXPLORER_MAX_RANGE_DAYS[q.bucket] * DAY_MS, {
    message: 'range too wide for this bucket size',
    path: ['to'],
  });

export const AccountsQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    compareFrom: isoDate.optional(),
    compareTo: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(SPEND_EXPLORER_MAX_ACCOUNTS).default(20),
    recache,
  })
  .refine(orderedRange, { message: 'from must be before to', path: ['from'] })
  .refine(q => !orderedRange(q) || q.to.getTime() - q.from.getTime() <= SPEND_EXPLORER_MAX_RANGE_DAYS.day * DAY_MS, {
    message: 'range too wide',
    path: ['to'],
  })
  .refine(q => !q.compareFrom === !q.compareTo, {
    message: 'compareFrom and compareTo go together',
    path: ['compareFrom'],
  })
  .refine(q => !isDate(q.compareFrom) || !isDate(q.compareTo) || q.compareFrom < q.compareTo, {
    message: 'compareFrom must be before compareTo',
    path: ['compareFrom'],
  });

/**
 * Cache key for one explorer response. Unversioned and short-lived on purpose, like the
 * short-TTL keys in server/utils/cacheKeys.ts: entries self-heal well inside a deploy.
 */
export function spendExplorerCacheKey(kind: 'timeline' | 'accounts', params: Record<string, unknown>): string {
  const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
  return `admin-spend-explorer:${kind}:${hash}`;
}

/** Five minutes: fresh enough for an unfolding spike, long enough to absorb tab flips. */
export const SPEND_EXPLORER_CACHE_MS = 5 * 60 * 1000;
