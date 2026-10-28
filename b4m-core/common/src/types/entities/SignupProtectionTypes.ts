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

export type SignupProtection = {
  repository: SignupProtectionRepository;
  mode?: 'observe' | 'enforce';
  notifyHold?: (review: SignupDomainReview) => Promise<void>;
};
