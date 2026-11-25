import { z } from 'zod';
import { CreditHolderType } from './CreditHolderTypes';

/**
 * Account segment: who an account is to the business. Stored on users and
 * organizations; an absent value reads as `customer`, so only internal and
 * partner accounts ever carry it. Spend explorer splits cost by it.
 */
export const ACCOUNT_SEGMENTS = ['internal', 'partner', 'customer'] as const;
export const AccountSegmentSchema = z.enum(ACCOUNT_SEGMENTS);
export type AccountSegment = z.infer<typeof AccountSegmentSchema>;
export type SpendSegment = AccountSegment | 'platform';
export const DEFAULT_ACCOUNT_SEGMENT: AccountSegment = 'customer';

/** A user is internal only through `IUser.isInternal`, so the stored user segment can only mark a partner. */
export const USER_ACCOUNT_SEGMENTS = ['partner'] as const;
export type UserAccountSegment = (typeof USER_ACCOUNT_SEGMENTS)[number];

export const SPEND_BUCKET_SIZES = ['hour', 'day'] as const;
export type SpendBucketSize = (typeof SPEND_BUCKET_SIZES)[number];

export const SPEND_SPLIT_DIMENSIONS = ['provider', 'segment', 'model', 'feature', 'source', 'funding'] as const;
export type SpendSplitDimension = (typeof SPEND_SPLIT_DIMENSIONS)[number];

/** Widest window each bucket size serves, which bounds the chart's point count (168 hours / 400 days). */
export const SPEND_EXPLORER_MAX_RANGE_DAYS: Record<SpendBucketSize, number> = { hour: 7, day: 400 };

/** Trailing buckets the rolling-median baseline looks back over. */
export const SPEND_BASELINE_WINDOW: Record<SpendBucketSize, number> = { hour: 24, day: 7 };

/** A bucket is a spike when its cost exceeds this multiple of its rolling-median baseline. */
export const SPEND_SPIKE_MULTIPLE = 1.5;

/** Below this bucket cost (USD) nothing is called a spike: sub-dollar swings are noise. */
export const SPEND_SPIKE_MIN_USD = 1;

/** Series past this many (by cost) fold into `other`, so a model or feature split stays legible. */
export const SPEND_EXPLORER_MAX_SERIES = 8;

export const SPEND_EXPLORER_OTHER_SERIES = 'other';

/** Hard cap on top-account rows in one response. */
export const SPEND_EXPLORER_MAX_ACCOUNTS = 50;
export const SPEND_EXPLORER_MAX_PAYERS = 3;

/** Whose events a segment split or breakdown treats as internal / partner (everyone else is a customer). */
export type SpendSegmentIds = {
  internal: string[];
  partner: string[];
};

export type SpendTimelineParams = {
  from: Date;
  to: Date;
  bucket: SpendBucketSize;
  splitBy: SpendSplitDimension;
  segmentIds: SpendSegmentIds;
  /** Narrow to the events one user ran (the actor), whoever paid for them. */
  actorUserId?: string;
};

/** Cost of one series in one bucket. `bucket` is `YYYY-MM-DD` or `YYYY-MM-DDTHH` (UTC). */
export type SpendTimelineRow = {
  bucket: string;
  key: string;
  costUsd: number;
  requests: number;
};

export type SpendBreakdownParams = {
  from: Date;
  to: Date;
  limit: number;
  segmentIds: SpendSegmentIds;
};

/** Who a share of an actor's cost was billed to: the user themself or their org. */
export type SpendBreakdownPayer = {
  ownerId: string;
  ownerType: CreditHolderType;
  costUsd: number;
};

/**
 * One acting user's spend. Keyed by `UsageEvent.userId`, not the owner, so a team member whose
 * spend bills to the org still shows up as themselves.
 */
export type SpendBreakdownActor = {
  userId: string;
  costUsd: number;
  requests: number;
  /** Largest first, at most SPEND_EXPLORER_MAX_PAYERS. */
  payers: SpendBreakdownPayer[];
};

export type SpendBreakdown = {
  totalCostUsd: number;
  byProvider: Array<{ provider: string; costUsd: number }>;
  bySegment: Array<{ segment: SpendSegment; costUsd: number }>;
  topActors: SpendBreakdownActor[];
};

/*
 * Wire contract for GET /api/admin/spend-explorer/{timeline,accounts}, shared by
 * the handlers and the admin Spend explorer page.
 */

export type SpendTimelineBucket = {
  /** Bucket start, ISO-8601 UTC. */
  start: string;
  totalUsd: number;
  /** Cost per series key; keys absent here are zero. */
  series: Record<string, number>;
  /** Rolling median of the SPEND_BASELINE_WINDOW preceding buckets (empty buckets count as zero). */
  baselineUsd: number;
  isSpike: boolean;
  /** Same-offset bucket of the previous equal-length period. */
  previousUsd: number;
};

export type SpendTimelineMarker = {
  at: string;
  kind: 'suspension';
  label: string;
};

export type SpendTimelineResponse = {
  bucket: SpendBucketSize;
  splitBy: SpendSplitDimension;
  /** Series keys ordered by cost, largest first. */
  seriesKeys: string[];
  buckets: SpendTimelineBucket[];
  markers: SpendTimelineMarker[];
};

export type SpendPayer = {
  ownerId: string;
  ownerType: CreditHolderType;
  name: string;
  costUsd: number;
};

/** One acting user in the top-spenders list, with who paid for their calls. */
export type SpendAccountRow = {
  /** The acting user's id (`UsageEvent.userId`). */
  accountId: string;
  name: string;
  segment: AccountSegment;
  costUsd: number;
  share: number;
  requests: number;
  /** Account creation time, ISO-8601; null when the user could not be resolved. */
  createdAt: string | null;
  /** Who was billed, largest first; the user themself appears here when they paid personally. */
  payers: SpendPayer[];
  /** In this window's top 10 but not the comparison window's. Always false without a comparison. */
  newInTop10: boolean;
};

export type SpendAccountsResponse = {
  totalCostUsd: number;
  byProvider: Array<{ provider: string; costUsd: number }>;
  bySegment: Array<{ segment: SpendSegment; costUsd: number }>;
  accounts: SpendAccountRow[];
};

/*
 * Feature cost: the Spend explorer's per-feature view (GET /api/admin/spend-explorer/features
 * and /feature-users). Error rows (SPEND_EXCLUDED_STATUSES) are left out of cost, credits and
 * units; error and timeout rows (SPEND_FAILED_STATUSES) are counted on their own as a reliability signal.
 */

/**
 * Whose usage a feature view counts. Same values and meaning as the Analytics tab's
 * `accounts` filter (ANALYTICS_ACCOUNTS): internal is the admin / system / synthetic /
 * staff-domain / Developer-tagged set `isCountedUser` excludes, so the two pages agree.
 */
export const SPEND_AUDIENCES = ['all', 'external', 'internal'] as const;
export const SpendAudienceSchema = z.enum(SPEND_AUDIENCES);
export type SpendAudience = z.infer<typeof SpendAudienceSchema>;

/** Statuses counted under `failedRequests`. */
export const SPEND_FAILED_STATUSES = ['error', 'timeout'] as const;

/**
 * Statuses left out of cost, credits and units. Timeouts stay in: a timed-out attempt records
 * the provider cost it absorbed (see timedOutAttemptUsage), so dropping it would hide real spend
 * and disagree with the explorer's timeline and breakdown, which count every row.
 */
export const SPEND_EXCLUDED_STATUSES = ['error'] as const;

/**
 * Largest `offset` the feature-users endpoint accepts. Only a sanity bound, set past any real
 * user count so every page the pager offers loads: grouping every user costs more than $skip.
 */
export const SPEND_FEATURE_USERS_MAX_OFFSET = 1_000_000;

/** A `UsageEvent.feature` id as the feature endpoints accept it. */
export const SPEND_FEATURE_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

/** Days before the last day that a feature's or user's trailing average covers. */
export const FEATURE_SPIKE_TRAILING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * End of the last complete UTC day a spike compares: `to`, or the start of today when `to` is
 * later. A preset range ends at tomorrow's midnight, and today's partial cost against full-day
 * averages would almost never flag. `to` must sit on a UTC day boundary.
 */
export function featureSpikeEnd(to: Date, now: Date): Date {
  const startOfToday = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return new Date(Math.min(to.getTime(), startOfToday));
}

/** Default for the `spendExplorerFeatureSpikeMultiple` admin setting. */
export const DEFAULT_FEATURE_SPIKE_MULTIPLE = 3;

/** Hard cap on one page of a feature's top users. */
export const SPEND_FEATURE_USERS_MAX_LIMIT = 100;

/**
 * What `UsageEvent.units` counts for a feature, where every writer of that feature agrees.
 * A feature missing here has no meaningful unit (token-billed, or mixed writers).
 */
export const FEATURE_UNIT_LABELS: Partial<Record<string, string>> = {
  image_generation: 'images',
  image_edit: 'images',
  text_to_speech: 'characters',
  sound_effects: 'seconds',
  music_generation: 'seconds',
  transcription: 'minutes',
};

export type FeatureSpikeInput = { lastDayUsd: number; trailingAvgUsd: number };

/**
 * A spike is last-day cost at or above SPEND_SPIKE_MIN_USD and above `multiple` times the
 * trailing daily average. With no trailing spend, any last day over the floor is a spike:
 * new spend on a feature is exactly what this flag is for.
 */
export function isFeatureSpendSpike({ lastDayUsd, trailingAvgUsd }: FeatureSpikeInput, multiple: number): boolean {
  return lastDayUsd >= SPEND_SPIKE_MIN_USD && lastDayUsd > trailingAvgUsd * multiple;
}

/** Sums the feature aggregations produce per group; error rows carry no cost. */
export type SpendFeatureTotals = {
  requests: number;
  failedRequests: number;
  costUsd: number;
  creditsCharged: number;
  units: number;
  /** Cost in the last complete UTC day, [spikeEnd - 1d, spikeEnd). */
  lastDayUsd: number;
  /** Cost over the FEATURE_SPIKE_TRAILING_DAYS days before the last day, which may start before `from`. */
  trailingUsd: number;
};

export type SpendFeaturesParams = {
  from: Date;
  to: Date;
  /** End of the last day the spike flags compare; at most `to` (see featureSpikeEnd). */
  spikeEnd: Date;
  /** Narrow to one acting user (UsageEvent.userId). */
  actorUserId?: string;
  /** Keep only these acting users (internal audience), or drop them (external). */
  userFilter?: { mode: 'include' | 'exclude'; userIds: string[] };
};

export type SpendFeatureAggregate = SpendFeatureTotals & {
  feature: string;
  distinctUsers: number;
  /** Cost per UTC day (`YYYY-MM-DD`) within [from, to); absent days are zero. */
  daily: Array<{ day: string; costUsd: number }>;
};

export type SpendFeatureUsersParams = Omit<SpendFeaturesParams, 'actorUserId'> & {
  feature: string;
  limit: number;
  offset: number;
};

export type SpendFeatureUserAggregate = SpendFeatureTotals & { userId: string };

export type SpendFeatureUsersPage = {
  users: SpendFeatureUserAggregate[];
  totalUsers: number;
  /** The feature's cost across every user in the view, not just this page. */
  featureCostUsd: number;
};

/** The window (and optionally one feature) whose distinct acting users an audience filter classifies. */
export type SpendActorScanParams = { from: Date; to: Date; spikeEnd: Date; feature?: string };

export type SpendFeatureRow = Omit<SpendFeatureAggregate, 'trailingUsd' | 'daily'> & {
  /** Share of the view's total cost. */
  share: number;
  unitLabel: string | null;
  trailingAvgUsd: number;
  isSpike: boolean;
  /** One value per UTC day of the range, oldest first. */
  dailyUsd: number[];
};

export type SpendFeaturesResponse = {
  audience: SpendAudience;
  totalCostUsd: number;
  spikeMultiple: number;
  /** Start of the last UTC day the spike flags compare, ISO-8601. */
  lastDayStart: string;
  /** Days of `dailyUsd`, `YYYY-MM-DD`. */
  days: string[];
  features: SpendFeatureRow[];
};

export type SpendFeatureUserRow = Omit<SpendFeatureUserAggregate, 'trailingUsd'> & {
  name: string;
  /** Share of the feature's cost in this view. */
  share: number;
  trailingAvgUsd: number;
  isSpike: boolean;
};

export type SpendFeatureUsersResponse = {
  feature: string;
  audience: SpendAudience;
  unitLabel: string | null;
  featureCostUsd: number;
  /** Users with any row for the feature in the view; drives pagination. */
  totalUsers: number;
  spikeMultiple: number;
  users: SpendFeatureUserRow[];
};
