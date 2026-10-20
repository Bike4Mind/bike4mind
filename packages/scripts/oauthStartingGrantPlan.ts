import { AuthStrategy, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

/** The consumer OAuth providers that signed users up with no starting grant before the fix. */
export const STARTING_GRANT_STRATEGIES: readonly string[] = [AuthStrategy.Google, AuthStrategy.Github];

export type StartingGrantUser = {
  id: string;
  email?: string | null;
  /** Null when the stored value is missing or unparseable. */
  createdAt: Date | null;
  currentCredits?: number | null;
  isAdmin?: boolean | null;
  isSystem?: boolean | null;
  isBanned?: boolean | null;
  tags?: string[] | null;
  authProviders?: ReadonlyArray<{ strategy?: string | null }> | null;
  /** Legacy single-provider field; older accounts may carry only this. */
  oauthCredentials?: { strategy?: string | null } | null;
};

export type SkipReason =
  | 'not-google-or-github'
  | 'missing-created-at'
  | 'created-after-cutoff'
  | 'system-account'
  | 'admin-account'
  | 'banned-account'
  | 'no-email'
  | 'internal-email'
  | 'test-email'
  | 'nonzero-balance'
  | 'pending-grant-tag'
  | 'disposable-email'
  | 'has-ledger-activity';

export type Classification = { eligible: true } | { eligible: false; reason: SkipReason };

export type PlanRules = {
  createdBefore: Date;
  /** Null when no internal domain is configured (an empty alternation would match every email). */
  internalEmail: RegExp | null;
  testEmail: RegExp;
};

export type PlanLookups = {
  disposableEmailUserIds: ReadonlySet<string>;
  /** Owner ids with any credit transaction; a starting grant, an adjustment or usage all disqualify. */
  ownersWithLedgerActivity: ReadonlySet<string>;
};

export type PlanContext = PlanRules & PlanLookups;

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

/**
 * Each skipped user is counted under its first matching reason. The email rules mirror the runtime
 * OAuth grant in verifyCallback.ts: no stored (provider-verified) email or a disposable one means
 * no flat grant. The pending tag is excluded because those users still have the runtime retry path
 * (releasePendingFreeCredits on verify); granting here would race it.
 */
export const classifyUser = (user: StartingGrantUser, context: PlanContext): Classification => {
  const skip = (reason: SkipReason): Classification => ({ eligible: false, reason });
  if (!usesStartingGrantStrategy(user)) return skip('not-google-or-github');
  if (user.createdAt === null) return skip('missing-created-at');
  if (user.createdAt >= context.createdBefore) return skip('created-after-cutoff');
  if (user.isSystem === true) return skip('system-account');
  if (user.isAdmin === true) return skip('admin-account');
  if (user.isBanned === true) return skip('banned-account');
  if (!user.email) return skip('no-email');
  if (context.internalEmail?.test(user.email)) return skip('internal-email');
  if (context.testEmail.test(user.email)) return skip('test-email');
  if ((user.currentCredits ?? 0) !== 0) return skip('nonzero-balance');
  if ((user.tags ?? []).includes(PENDING_FREE_CREDITS_TAG)) return skip('pending-grant-tag');
  if (context.disposableEmailUserIds.has(user.id)) return skip('disposable-email');
  if (context.ownersWithLedgerActivity.has(user.id)) return skip('has-ledger-activity');
  return { eligible: true };
};

const emptySkipCounts = (): Record<SkipReason, number> => ({
  'not-google-or-github': 0,
  'missing-created-at': 0,
  'created-after-cutoff': 0,
  'system-account': 0,
  'admin-account': 0,
  'banned-account': 0,
  'no-email': 0,
  'internal-email': 0,
  'test-email': 0,
  'nonzero-balance': 0,
  'pending-grant-tag': 0,
  'disposable-email': 0,
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

export type PlanLookupSources = {
  findDisposableEmailUserIds: (users: readonly StartingGrantUser[]) => Promise<ReadonlySet<string>>;
  findOwnersWithLedgerActivity: (userIds: readonly string[]) => Promise<ReadonlySet<string>>;
};

/** The lookups hit the settings and the ledger, so they run only for users that pass every in-memory rule. */
export const buildPlan = async (
  users: readonly StartingGrantUser[],
  rules: PlanRules,
  sources: PlanLookupSources
): Promise<BackfillPlan> => {
  const preliminary = planBackfill(users, {
    ...rules,
    disposableEmailUserIds: new Set(),
    ownersWithLedgerActivity: new Set(),
  });
  const [disposableEmailUserIds, ownersWithLedgerActivity] = await Promise.all([
    sources.findDisposableEmailUserIds(preliminary.eligible),
    sources.findOwnersWithLedgerActivity(preliminary.eligible.map(user => user.id)),
  ]);
  return planBackfill(users, { ...rules, disposableEmailUserIds, ownersWithLedgerActivity });
};

export type BackfillArgs = {
  execute: boolean;
  createdBefore: Date;
  /** Required with --execute: the run aborts unless defaultFreeCredits resolves to exactly this. */
  expectAmount: number | null;
  /** Added to the NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS list. */
  extraInternalDomains: string[];
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
    extraInternalDomains: readFlagValues(argv, '--exclude-email-domain'),
  };
};
