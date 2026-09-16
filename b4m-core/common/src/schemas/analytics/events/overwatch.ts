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
  /**
   * Product's internal user ID, or OVERWATCH_ANONYMOUS_USER_ID when the event has no
   * identified user. See the session and identity conventions below.
   */
  userId: z.string().min(1).max(256),
  /**
   * Visit identifier. Overwatch counts distinct values of this per product as the first
   * stage of its acquisition funnel, so one value per visit is what makes that count a
   * count of visits. An emitter that cannot tell which visit a request belongs to sends
   * OVERWATCH_UNKNOWN_SESSION_ID rather than a value of its own invention - see the
   * conventions below.
   */
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
// Session and identity conventions
//
// Overwatch does not mint identifiers; it counts distinct values of what a
// product sends. That makes two cases worth naming rather than improvising,
// because the improvised versions are both silent:
//
//   - An event with no identified user. Sending a per-visit value as the userId
//     turns every anonymous visitor into a distinct user, which inflates DAU and
//     makes a distinct-users/user-days ratio saturate; omitting the field is not
//     an option because it is required. OVERWATCH_ANONYMOUS_USER_ID is one fixed
//     value, so a consumer can recognise it and keep it out of per-user
//     aggregates instead of counting it as one more user.
//   - An event whose emitter cannot tell which visit it belongs to (a request
//     carrying no visit cookie, a server-to-server call). A freshly invented id
//     per event would add one phantom session per event to the funnel's first
//     stage; OVERWATCH_UNKNOWN_SESSION_ID adds exactly one per product per range
//     and can be excluded outright, which is the difference between a bounded
//     known error and an unbounded unknown one.
//
// Both are colon-namespaced so they cannot collide with a product's own ids, and
// both are plain strings the existing schema already accepts, so honouring them
// costs a consumer a filter rather than a migration.
// ---------------------------------------------------------------------------

/**
 * Event name for the start of a visit: exactly one per visit, carrying that visit's
 * identifier as its sessionId. A product that emits these gives Overwatch's funnel a
 * first stage that means visits, including visits by users who never sign in.
 */
export const OVERWATCH_VISIT_EVENT = 'visit';

/** userId for an event with no identified user. Never fold it into a per-user aggregate. */
export const OVERWATCH_ANONYMOUS_USER_ID = 'overwatch:anonymous';

/** sessionId for an event whose emitter could not observe which visit it belonged to. */
export const OVERWATCH_UNKNOWN_SESSION_ID = 'overwatch:no-session';

/** True for an event that carries no user identity - exclude it from per-user counts. */
export function isAnonymousOverwatchUserId(userId: string): boolean {
  return userId === OVERWATCH_ANONYMOUS_USER_ID;
}

/** True for a sessionId that stands for "unknown visit" - exclude it from session counts. */
export function isUnknownOverwatchSessionId(sessionId: string): boolean {
  return sessionId === OVERWATCH_UNKNOWN_SESSION_ID;
}

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
