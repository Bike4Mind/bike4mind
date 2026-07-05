import { z } from 'zod';

/**
 * Overwatch Analytics Event Schema
 *
 * Cross-product event schema for the Overwatch marketing command center.
 * Products (VibesWire, B4M, StocksAndVibes, K2Kanji) emit these events
 * to a shared SQS queue. Overwatch consumes them and rolls up DAU/WAU/MAU.
 *
 * Unlike the B4M-internal IBaseEvent analytics events, this schema is
 * designed for cross-product use with Zod validation at both emission
 * and consumption boundaries.
 */

export const OverwatchUtmSchema = z.object({
  source: z.string().max(128).optional(),
  medium: z.string().max(128).optional(),
  campaign: z.string().max(128).optional(),
  content: z.string().max(128).optional(),
});

export const OverwatchAnalyticsEventSchema = z.object({
  /** UUID for deduplication (SQS is at-least-once) */
  eventId: z.string().uuid(),
  /** Schema version for forward compatibility */
  schemaVersion: z.number().int().positive(),
  /** Product identifier: 'vibeswire', 'bike4mind', 'stocksandvibes', 'k2kanji', etc. */
  productId: z.string().min(1).max(64),
  /** Product's internal user ID */
  userId: z.string().min(1).max(256),
  /** Session identifier for retention/funnel analysis */
  sessionId: z.string().min(1).max(256),
  /** Event type: 'session_start', 'signup', 'feature_used', etc. */
  event: z.string().min(1).max(128),
  /** ISO 8601 timestamp */
  timestamp: z.string().datetime(),
  /** Where the user came from */
  referrer: z
    .string()
    .url()
    .refine(url => /^https?:\/\//i.test(url), 'referrer must be an http or https URL')
    .max(2048)
    .optional(),
  /** UTM attribution parameters */
  utm: OverwatchUtmSchema.optional(),
  /** Event-specific key-value data. Flat values only, max 1KB serialized. */
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .refine(v => JSON.stringify(v).length <= 1024, 'metadata must be ≤ 1KB serialized')
    .optional(),
});

export type OverwatchAnalyticsEvent = z.infer<typeof OverwatchAnalyticsEventSchema>;
export type OverwatchUtm = z.infer<typeof OverwatchUtmSchema>;

/** Current schema version - increment when making breaking changes */
export const OVERWATCH_ANALYTICS_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// User type convention - include in metadata.userType when emitting events.
// Case-sensitive: 'subscriber' is valid, 'Subscriber' is dropped server-side.
// Send on every event for the user; the Lambda picks the latest value per day.
// Non-allowlist values are silently dropped; the event still persists.
// ---------------------------------------------------------------------------

export const OVERWATCH_USERTYPE_VALUES = ['subscriber', 'free', 'trial'] as const;
export type OverwatchUserType = (typeof OVERWATCH_USERTYPE_VALUES)[number];

// ---------------------------------------------------------------------------
// UTM constants - use these when emitting events from product SDKs
// ---------------------------------------------------------------------------

export const OVERWATCH_UTM_SOURCES = {
  VIBESWIRE: 'vibeswire',
  BIKE4MIND: 'bike4mind',
  STOCKS_AND_VIBES: 'stocks-and-vibes',
  K2KANJI: 'k2kanji',
  ERIK_BETHKE: 'erikbethke',
} as const;

export const OVERWATCH_UTM_MEDIUMS = {
  EMAIL: 'email',
  SOCIAL: 'social',
  REFERRAL: 'referral',
  ORGANIC: 'organic',
  PAID: 'paid',
} as const;

export const OVERWATCH_UTM_CAMPAIGNS = {
  PRODUCT_LAUNCH: 'product-launch',
  ONBOARDING: 'onboarding',
  RETENTION: 'retention',
  CROSS_PROMOTION: 'cross-promotion',
} as const;
