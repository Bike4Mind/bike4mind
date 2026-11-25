export const SIDE_APP_TIER_BUCKETS = ['paid', 'unpaid', 'org', 'unrecorded'] as const;
export type SideAppTierBucket = (typeof SIDE_APP_TIER_BUCKETS)[number];

export const SIDE_APP_REQUEST_TIERS = ['paid', 'unpaid', 'unrecorded'] as const;
export type SideAppRequestTier = (typeof SIDE_APP_REQUEST_TIERS)[number];

export type SideAppRefusalClassName = 'policy' | 'app_fault' | 'our_fault';

export type SideAppTierCredits = Record<SideAppTierBucket, number>;
export type SideAppTierRequests = Record<SideAppRequestTier, number>;

export interface SideAppDailyCredits {
  day: string;
  credits: number;
}

export interface SideAppEndpointRequests extends SideAppTierRequests {
  endpoint: string;
  total: number;
}

export interface SideAppOutcomeSummary {
  completed: number;
  failed: number;
  interrupted: number;
  /** Failed plus interrupted over every finished outcome; null when none finished. */
  failureRate: number | null;
}

export interface SideAppRefusalReason {
  reason: string;
  class: SideAppRefusalClassName;
  count: number;
}

export interface SideAppRefusalSummary {
  total: number;
  byClass: Record<SideAppRefusalClassName, number>;
  byReason: SideAppRefusalReason[];
}

export interface SideAppFailureCode {
  code: string;
  count: number;
}

export interface SideAppRow {
  clientId: string;
  name: string;
  spend: {
    credits: number;
    payingUsers: number;
    byTier: SideAppTierCredits;
    daily: SideAppDailyCredits[];
  };
  requests: {
    total: number;
    byTier: SideAppTierRequests;
    byEndpoint: SideAppEndpointRequests[];
  };
  outcomes: SideAppOutcomeSummary;
  /** Most frequent completion failure codes over the request window, at most five. */
  topFailureCodes: SideAppFailureCode[];
  refusals: SideAppRefusalSummary;
}

export interface SideAppsResponse {
  days: number;
  /** Window the spend figures cover, in days (1 to 365). */
  spendWindowDays: number;
  /** Window requests, outcomes and refusals cover; capped by the 90-day log retention. */
  requestWindowDays: number;
  /** Earliest ledger row carrying the app and tier, or null when none has been recorded yet. */
  attributionStartedAt: string | null;
  totals: {
    credits: number;
    activeUsers: number;
    byTier: SideAppTierCredits;
    /** Unpaid over paid plus unpaid user-paid credits; null when neither has spend. */
    unpaidShare: number | null;
    outcomes: SideAppOutcomeSummary;
    daily: SideAppDailyCredits[];
  };
  apps: SideAppRow[];
  /** Refusals whose client id was only a claim, never mixed into an app row. */
  unknownClient: SideAppRefusalSummary;
}

export type SideAppUserTier = 'paid' | 'unpaid' | 'unknown';

export interface SideAppModelSpend {
  model: string;
  credits: number;
}

export interface SideAppUserRow {
  userId: string;
  name: string | null;
  email: string | null;
  /** Standing right now; 'unknown' when the read failed, never 'unpaid' by default. */
  currentTier: SideAppUserTier;
  credits: number;
  creditsByTier: SideAppTierCredits;
  requests: number;
  requestsByEndpoint: { endpoint: string; count: number }[];
  failedRequests: number;
  refusals: number;
  lastUsedAt: string | null;
  topModels: SideAppModelSpend[];
}

export interface SideAppUsersResponse {
  clientId: string;
  name: string;
  days: number;
  spendWindowDays: number;
  requestWindowDays: number;
  attributionStartedAt: string | null;
  totalUsers: number;
  /** Rows beyond this count are cut off, ordered by credits. */
  limit: number;
  users: SideAppUserRow[];
  /** Org-paid credits whose acting member was not recorded, so no user row carries them. */
  unattributedOrgCredits: number;
}
