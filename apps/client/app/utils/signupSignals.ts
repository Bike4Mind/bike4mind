/**
 * The suspected-signup signals and the signup time-series response, shared by the classifier
 * (server/users/signupClassifier.ts), the endpoint (pages/api/admin/signup-timeseries.ts) and the
 * admin charts. Keep the order stable: the charts assign series colors by this order.
 */
export const SIGNUP_SIGNALS = [
  'domainBurst',
  'domainCadence',
  'wafBotSignal',
  'datacenterNetwork',
  'earlyApiKey',
  'patternedEmail',
  'dormantAfterSignup',
  'signupSpike',
  'sharedNetwork',
  'aliasedEmail',
] as const;

export type SignupSignal = (typeof SIGNUP_SIGNALS)[number];

/** Signals that mark an account suspected on their own; the rest need a second weak signal. */
export const STRONG_SIGNUP_SIGNALS: ReadonlySet<SignupSignal> = new Set([
  'domainBurst',
  'domainCadence',
  'wafBotSignal',
]);

/** Signals derived from the account's email-domain cohort, used by the domain-group review table too. */
export const DOMAIN_SIGNUP_SIGNALS = ['domainBurst', 'domainCadence', 'patternedEmail'] as const;
export type DomainSignupSignal = (typeof DOMAIN_SIGNUP_SIGNALS)[number];

export const SIGNUP_SIGNAL_LABELS: Record<SignupSignal, { label: string; description: string }> = {
  domainBurst: {
    label: 'Domain burst',
    description: 'Many accounts on the same non-webmail domain within one hour.',
  },
  domainCadence: {
    label: 'Machine-regular cadence',
    description: 'A run of accounts on the same non-webmail domain created at evenly spaced intervals.',
  },
  wafBotSignal: { label: 'Bot traffic', description: 'The firewall labeled the signup request as bot traffic.' },
  datacenterNetwork: {
    label: 'Datacenter network',
    description: 'The signup came from a hosting or cloud network rather than a consumer ISP.',
  },
  earlyApiKey: { label: 'API key within 24h', description: 'An API key was created within 24 hours of signup.' },
  patternedEmail: {
    label: 'Patterned addresses',
    description: 'Several addresses on one domain share a template that differs only in its digits.',
  },
  dormantAfterSignup: {
    label: 'No activity after signup',
    description: 'The account is over a day old and was never active after its first session, or never active at all.',
  },
  signupSpike: {
    label: 'Signup spike',
    description:
      'Created in an hour with at least ten times the usual number of signups, webmail included. Weak alone: real users can sign up during a spike too.',
  },
  sharedNetwork: {
    label: 'Shared network',
    description: 'Three or more accounts signed up from the same network range within 24 hours.',
  },
  aliasedEmail: {
    label: 'Aliased address',
    description: 'Delivers to the same inbox as another new account once Gmail dots and plus tags are removed.',
  },
};

export const isSuspectedSignup = (signals: readonly SignupSignal[]): boolean =>
  signals.some(signal => STRONG_SIGNUP_SIGNALS.has(signal)) || signals.length >= 2;

export const SIGNUP_TIMESERIES_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type SignupTimeseriesRange = (typeof SIGNUP_TIMESERIES_RANGES)[number];

export const SIGNUP_TIMESERIES_RANGE_LABELS: Record<SignupTimeseriesRange, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

export type SignupSignalCounts = Record<SignupSignal, number>;

export type SignupTimeseriesBucket = {
  /** ISO instant the bucket starts at. */
  start: string;
  total: number;
  suspected: number;
  likelyLegit: number;
  /** Signups past the classification scan cap; counted in `total` only. */
  unclassified: number;
  bySignal: SignupSignalCounts;
  /** Median and 90th percentile of the preceding buckets' totals; null without enough history. */
  baseline: { median: number; p90: number } | null;
};

export type SignupTimeseries = {
  range: SignupTimeseriesRange;
  bucket: 'hour' | 'day';
  since: string;
  until: string;
  buckets: SignupTimeseriesBucket[];
  totals: Omit<SignupTimeseriesBucket, 'start' | 'baseline'>;
  /** The classification scan hit its cap; the oldest signups are counted but not classified. */
  truncated: boolean;
  /** The API key scan hit its cap; `earlyApiKey` counts are lower bounds. */
  keysTruncated: boolean;
};

/** One account's verdict from the chart's classifier; the signals say why. */
export type SignupVerdict = { suspected: boolean; signals: SignupSignal[] };

/** Response of /api/admin/users/signup-verdicts: null for an account the chart did not classify. */
export type SignupVerdicts = { verdicts: Record<string, SignupVerdict | null> };

/** Most ids one verdict request may carry: the largest Users page. */
export const SIGNUP_VERDICTS_MAX_IDS = 100;

export const emptySignalCounts = (): SignupSignalCounts =>
  Object.fromEntries(SIGNUP_SIGNALS.map(signal => [signal, 0])) as SignupSignalCounts;
