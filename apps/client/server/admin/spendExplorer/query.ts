import { createHash } from 'node:crypto';
import {
  SPEND_BUCKET_SIZES,
  SPEND_EXPLORER_MAX_ACCOUNTS,
  SPEND_EXPLORER_MAX_RANGE_DAYS,
  SPEND_FEATURE_ID_PATTERN,
  SPEND_FEATURE_USERS_MAX_LIMIT,
  SPEND_FEATURE_USERS_MAX_OFFSET,
  SPEND_SPLIT_DIMENSIONS,
  SpendAudienceSchema,
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

const autoBucket = (from: Date, to: Date): SpendBucketSize =>
  (to.getTime() - from.getTime()) / DAY_MS <= HOURLY_AUTO_MAX_DAYS ? 'hour' : 'day';

const withinWidth = (from: unknown, to: unknown, maxDays: number) =>
  !isDate(from) || !isDate(to) || to.getTime() - from.getTime() <= maxDays * DAY_MS;

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
  // Checked on the requested range, before snapping widens it to whole buckets.
  .refine(
    q =>
      !orderedRange(q) ||
      withinWidth(q.from, q.to, SPEND_EXPLORER_MAX_RANGE_DAYS[q.bucket ?? autoBucket(q.from as Date, q.to as Date)]),
    { message: 'range too wide for this bucket size', path: ['to'] }
  )
  .transform(q => {
    const bucket: SpendBucketSize = q.bucket ?? autoBucket(q.from, q.to);
    // Snap to whole UTC buckets so every bucket is complete and keys line up with the aggregation.
    return { ...q, bucket, from: floorToBucket(q.from, bucket), to: ceilToBucket(q.to, bucket) };
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
  .refine(q => !orderedRange(q) || withinWidth(q.from, q.to, SPEND_EXPLORER_MAX_RANGE_DAYS.day), {
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
  })
  .refine(q => withinWidth(q.compareFrom, q.compareTo, SPEND_EXPLORER_MAX_RANGE_DAYS.day), {
    message: 'comparison range too wide',
    path: ['compareTo'],
  });

// The feature view works in whole UTC days: its daily trend buckets and spike window are days.
const featureRangeFields = {
  from: isoDate,
  to: isoDate,
  audience: SpendAudienceSchema.default('all'),
  recache,
};

const withFeatureRangeChecks = <S extends z.ZodType<{ from: unknown; to: unknown }>>(schema: S) =>
  schema
    .refine(orderedRange, { message: 'from must be before to', path: ['from'] })
    .refine(q => !orderedRange(q) || withinWidth(q.from, q.to, SPEND_EXPLORER_MAX_RANGE_DAYS.day), {
      message: 'range too wide',
      path: ['to'],
    });

const snapToDays = <Q extends { from: Date; to: Date }>(q: Q): Q => ({
  ...q,
  from: floorToBucket(q.from, 'day'),
  to: ceilToBucket(q.to, 'day'),
});

export const FeaturesQuerySchema = withFeatureRangeChecks(
  z.object({ ...featureRangeFields, userId: z.string().min(1).max(64).optional() })
).transform(snapToDays);

export const FeatureUsersQuerySchema = withFeatureRangeChecks(
  z.object({
    ...featureRangeFields,
    // UsageEvent.feature values, legacy ones included, so not the current enum.
    feature: z.string().regex(SPEND_FEATURE_ID_PATTERN, 'invalid feature'),
    limit: z.coerce.number().int().min(1).max(SPEND_FEATURE_USERS_MAX_LIMIT).default(20),
    offset: z.coerce.number().int().min(0).max(SPEND_FEATURE_USERS_MAX_OFFSET).default(0),
  })
).transform(snapToDays);

/**
 * Cache key for one explorer response. Unversioned and short-lived on purpose, like the
 * short-TTL keys in server/utils/cacheKeys.ts: entries self-heal well inside a deploy.
 */
export function spendExplorerCacheKey(
  kind: 'timeline' | 'accounts' | 'features' | 'feature-users',
  params: Record<string, unknown>
): string {
  const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
  return `admin-spend-explorer:${kind}:${hash}`;
}

/** Five minutes: fresh enough for an unfolding spike, long enough to absorb tab flips. */
export const SPEND_EXPLORER_CACHE_MS = 5 * 60 * 1000;
