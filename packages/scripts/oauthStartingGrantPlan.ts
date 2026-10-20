import { AuthStrategy, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

/** The consumer OAuth providers that signed users up with no starting grant before the fix. */
export const STARTING_GRANT_STRATEGIES: readonly string[] = [AuthStrategy.Google, AuthStrategy.Github];

export const DEFAULT_EXCLUDED_EMAIL_DOMAINS: readonly string[] = ['bike4mind.com'];

export type StartingGrantUser = {
  id: string;
  email?: string | null;
  createdAt: Date;
  currentCredits?: number | null;
  isAdmin?: boolean | null;
  isSystem?: boolean | null;
  tags?: string[] | null;
  authProviders?: ReadonlyArray<{ strategy?: string | null }> | null;
  /** Legacy single-provider field; older accounts may carry only this. */
  oauthCredentials?: { strategy?: string | null } | null;
};

export type SkipReason =
  | 'not-google-or-github'
  | 'created-after-cutoff'
  | 'system-account'
  | 'admin-account'
  | 'excluded-email-domain'
  | 'nonzero-balance'
  | 'pending-grant-tag'
  | 'has-ledger-activity';

export type Classification = { eligible: true } | { eligible: false; reason: SkipReason };

export type PlanContext = {
  createdBefore: Date;
  excludedEmailDomains: readonly string[];
  /** Owner ids with any credit transaction; a starting grant, an adjustment or usage all disqualify. */
  ownersWithLedgerActivity: ReadonlySet<string>;
};

export type BackfillPlan = {
  eligible: StartingGrantUser[];
  skipped: Record<SkipReason, number>;
};

const usesStartingGrantStrategy = (user: StartingGrantUser): boolean => {
  const strategies = [
    ...(user.authProviders ?? []).map(provider => provider.strategy),
    user.oauthCredentials?.strategy,
  ];
  return strategies.some(strategy => typeof strategy === 'string' && STARTING_GRANT_STRATEGIES.includes(strategy));
};

const hasExcludedEmailDomain = (email: string | null | undefined, domains: readonly string[]): boolean => {
  if (!email) return false;
  const normalized = email.toLowerCase();
  return domains.some(domain => normalized.endsWith(`@${domain.toLowerCase()}`));
};

/**
 * Checks run cheapest-and-most-structural first so each skipped user is counted under one reason.
 * The pending tag is excluded because those users still have the runtime retry path
 * (releasePendingFreeCredits on verify); granting here would race it.
 */
export const classifyUser = (user: StartingGrantUser, context: PlanContext): Classification => {
  if (!usesStartingGrantStrategy(user)) return { eligible: false, reason: 'not-google-or-github' };
  if (user.createdAt >= context.createdBefore) return { eligible: false, reason: 'created-after-cutoff' };
  if (user.isSystem === true) return { eligible: false, reason: 'system-account' };
  if (user.isAdmin === true) return { eligible: false, reason: 'admin-account' };
  if (hasExcludedEmailDomain(user.email, context.excludedEmailDomains)) {
    return { eligible: false, reason: 'excluded-email-domain' };
  }
  if ((user.currentCredits ?? 0) !== 0) return { eligible: false, reason: 'nonzero-balance' };
  if ((user.tags ?? []).includes(PENDING_FREE_CREDITS_TAG)) return { eligible: false, reason: 'pending-grant-tag' };
  if (context.ownersWithLedgerActivity.has(user.id)) return { eligible: false, reason: 'has-ledger-activity' };
  return { eligible: true };
};

const emptySkipCounts = (): Record<SkipReason, number> => ({
  'not-google-or-github': 0,
  'created-after-cutoff': 0,
  'system-account': 0,
  'admin-account': 0,
  'excluded-email-domain': 0,
  'nonzero-balance': 0,
  'pending-grant-tag': 0,
  'has-ledger-activity': 0,
});

export const planBackfill = (users: readonly StartingGrantUser[], context: PlanContext): BackfillPlan => {
  const plan: BackfillPlan = { eligible: [], skipped: emptySkipCounts() };
  for (const user of users) {
    const classification = classifyUser(user, context);
    if (classification.eligible) plan.eligible.push(user);
    else plan.skipped[classification.reason]++;
  }
  return plan;
};

export type BackfillArgs = {
  execute: boolean;
  createdBefore: Date;
  /** Required with --execute: the run aborts unless defaultFreeCredits resolves to exactly this. */
  expectAmount: number | null;
  excludedEmailDomains: readonly string[];
};

const readFlagValues = (argv: readonly string[], flag: string): string[] =>
  argv.filter(arg => arg.startsWith(`${flag}=`)).map(arg => arg.slice(flag.length + 1));

const parseCreatedBefore = (argv: readonly string[]): Date => {
  const [raw] = readFlagValues(argv, '--created-before');
  if (!raw) {
    throw new Error(
      '--created-before=<ISO timestamp> is required: the moment the OAuth starting-grant fix went live on this stage'
    );
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`--created-before is not a valid date: ${raw}`);
  return date;
};

const parseExpectAmount = (argv: readonly string[]): number | null => {
  const [raw] = readFlagValues(argv, '--expect-amount');
  if (raw === undefined) return null;
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`--expect-amount must be a positive integer: ${raw}`);
  }
  return amount;
};

export const parseBackfillArgs = (argv: readonly string[]): BackfillArgs => {
  const execute = argv.includes('--execute');
  const expectAmount = parseExpectAmount(argv);
  if (execute && expectAmount === null) {
    throw new Error('--execute requires --expect-amount=<credits> so a misconfigured defaultFreeCredits fails fast');
  }
  return {
    execute,
    createdBefore: parseCreatedBefore(argv),
    expectAmount,
    excludedEmailDomains: [...DEFAULT_EXCLUDED_EMAIL_DOMAINS, ...readFlagValues(argv, '--exclude-email-domain')],
  };
};
