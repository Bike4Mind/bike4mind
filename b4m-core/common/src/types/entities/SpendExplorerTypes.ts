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
  bySegment: Array<{ segment: AccountSegment; costUsd: number }>;
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
  bySegment: Array<{ segment: AccountSegment; costUsd: number }>;
  accounts: SpendAccountRow[];
};
