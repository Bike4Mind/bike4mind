import { z } from 'zod';

export type SignupObservation = { userId: string; email: string; domain: string; verifiedAt: Date };
export const signupDomainReviewSchema = z.object({
  domain: z.string(),
  status: z.enum(['held_pending_review', 'blocked', 'released']),
  reason: z.string(),
  triggeredAt: z.date(),
  cohortUserIds: z.array(z.string()),
  sampleEmails: z.array(z.string()),
  signupCount: z.number(),
});
export type SignupDomainReview = z.infer<typeof signupDomainReviewSchema>;

/** Refreshed disposable-domain lists; see apps/workers/src/cron/disposableDomainRefresh.ts for the URLs. */
export type DisposableListSource = 'aggregate' | 'curated' | 'fakefilter';
export type DisposableSourceStatus = {
  source: DisposableListSource;
  count: number;
  lastSuccessAt?: Date;
  lastError?: string;
  lastErrorAt?: Date;
};
/** Cached RDAP/MX facts for one registrable domain. `failed` names the lookups that did not answer. */
export type DomainIntel = {
  domain: string;
  registeredAt?: Date;
  mxHosts: string[];
  mxFlags: string[];
  failed: ('rdap' | 'mx')[];
  checkedAt: Date;
  expiresAt: Date;
};

export type SignupProtectionRepository = {
  observe: (signup: SignupObservation) => Promise<void>;
  recent: (domain: string, since: Date) => Promise<SignupObservation[]>;
  findReview: (domain: string) => Promise<SignupDomainReview | null>;
  createHold: (review: SignupDomainReview) => Promise<boolean>;
  isOrganizationDomain: (email: string) => Promise<boolean>;
  // Optional so consumers without the refreshed lists or intel cache keep the list-only behaviour.
  /** The union of refreshed-list sources over the given domain candidates. */
  disposableSources?: (domains: string[]) => Promise<DisposableListSource[]>;
  /** Null when absent or expired. */
  findDomainIntel?: (domain: string) => Promise<DomainIntel | null>;
  saveDomainIntel?: (intel: DomainIntel) => Promise<void>;
};

/** Free-credit pools with separate daily budgets: initial grants vs the daily activity drip. */
export type SignupGrantPool = 'signup' | 'trickle';

export type SignupGrantBudgetThreshold = 50 | 100 | 'missing';

/**
 * Per-UTC-day spend counter for free grants, one per pool. Each method's `day` is the counter key:
 * the service passes `<pool>:<YYYY-MM-DD>`.
 */
export type SignupGrantBudgetRepository = {
  /**
   * Adds `amount` to the day's spend only while it stays within `budget`, keyed by `transactionId`
   * so a retried payout reserves once. Resolves the day's total after the reservation (`fresh` is
   * false when `transactionId` already held one, so only the first holder may refund it), or null
   * when the budget cannot cover it.
   */
  reserve: (
    day: string,
    transactionId: string,
    amount: number,
    budget: number
  ) => Promise<{ spent: number; fresh: boolean } | null>;
  /** Returns a reservation. A no-op when `transactionId` holds none, so it never double-refunds. */
  refund: (day: string, transactionId: string, amount: number) => Promise<void>;
  /** True only for the call that first sets the day's alert flag. */
  markAlerted: (day: string, threshold: SignupGrantBudgetThreshold) => Promise<boolean>;
  /** The day's spend; 0 when no row exists. */
  getSpent: (day: string) => Promise<number>;
};

/** `missing` fires when the pool's setting is absent or invalid, which pauses the pool. */
export type SignupGrantBudgetAlert = {
  pool: SignupGrantPool;
  day: string;
  threshold: SignupGrantBudgetThreshold;
  spent: number;
  budget: number;
};

export type SignupGrantBudget = {
  repository: SignupGrantBudgetRepository;
  notify?: (alert: SignupGrantBudgetAlert) => Promise<void>;
  /**
   * Queued gear/referral rewards (creditService.payCreditReward). A daily drip waits only when the trickle
   * pool could no longer cover the oldest of them after the drip (queueHeadBlocks).
   */
  heldRewards?: { oldestHeldCredits(maxCredits?: number): Promise<number | null> };
  /** Clock override for the budget's UTC day; tests only. */
  now?: () => Date;
};

export type SignupProtection = {
  repository: SignupProtectionRepository;
  mode?: 'observe' | 'enforce';
  notifyHold?: (review: SignupDomainReview) => Promise<void>;
  /** Daily per-pool payout budgets for free signup grants; absent means no budget is enforced. */
  grantBudget?: SignupGrantBudget;
};
