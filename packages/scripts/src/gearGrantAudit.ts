import { parseArgs } from 'node:util';
import { DEFAULT_TEST_PATTERN, exclusionReason, type ExclusionRules, type UserRecord } from './externalActiveUsers';

/**
 * Pure aggregation for the gear grant audit (no DB access). The reads live in ./gearGrantAuditData.ts
 * and the entry point in ./gear-grant-audit.ts.
 *
 * A gear payout is a CreditTransaction whose transactionId is `gear-unlock:<userId>:<key>` (gearTxId in
 * apps/client/server/services/gears/catalog.ts). A reward queued for the trickle pool is a
 * HeldCreditReward row with source 'gear' and the same transactionId; its claim time is heldAt, and its
 * ledger row is written when the hourly release pays it. Internal accounts are excluded with the rules
 * of the external activity report (./externalActiveUsers.ts).
 */

export const DEFAULT_WINDOW_DAYS = 30;
// One day past the default gearRewardMinAccountAgeDays (7), so it catches claims made as soon as the gate opens.
export const DEFAULT_WITHIN_DAYS = 8;
/** Claim counts the new-account section reports, besides every active gear. */
export const CLAIM_TIERS = [5, 10, 20];
export const DEFAULT_TOP = 10;
export const GEAR_TX_PREFIX = 'gear-unlock:';

const MS_PER_DAY = 86_400_000;

// --- Args ---

export interface GearAuditArgs {
  help: boolean;
  days: number;
  withinDays: number;
  top: number;
  testPattern: RegExp;
  out?: string;
}

export const HELP_TEXT = `Gear grant audit (read-only). Prints a markdown report.

Usage: report:gear-grant-audit [--days <n>] [--within-days <n>] [--top <n>] [--test-pattern <regex>] [--out <path>]

  --days <n>             Window in days ending now (default ${DEFAULT_WINDOW_DAYS}).
  --within-days <n>      Signup-to-claim span for the new-account claim counts (default ${DEFAULT_WITHIN_DAYS}).
  --top <n>              Rows in the per-account and per-model tables (default ${DEFAULT_TOP}).
  --test-pattern <regex> Exclude accounts whose email matches (case-insensitive). Default: ${DEFAULT_TEST_PATTERN}
  --out <path>           Write the report to a file instead of stdout.

Excluded: admins, isSynthetic accounts, NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS emails, --test-pattern emails and
payouts whose owner has no User document.

Env: MONGODB_URI (or the SST config), NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS (comma-separated).`;

const positiveInt = (flag: string, value: string): number => {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--${flag} needs a positive integer`);
  return Number(value);
};

/** `args` is argv without the node and script entries. Unknown flags throw so typos do not run silently. */
export function parseGearAuditArgs(args: string[]): GearAuditArgs {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      days: { type: 'string', default: String(DEFAULT_WINDOW_DAYS) },
      'within-days': { type: 'string', default: String(DEFAULT_WITHIN_DAYS) },
      top: { type: 'string', default: String(DEFAULT_TOP) },
      'test-pattern': { type: 'string', default: DEFAULT_TEST_PATTERN },
      out: { type: 'string' },
    },
    strict: true,
  });
  let testPattern: RegExp;
  try {
    testPattern = new RegExp(values['test-pattern'], 'i');
  } catch {
    throw new Error(`--test-pattern is not a valid regex: ${values['test-pattern']}`);
  }
  return {
    help: values.help,
    days: positiveInt('days', values.days),
    withinDays: positiveInt('within-days', values['within-days']),
    top: positiveInt('top', values.top),
    testPattern,
    out: values.out,
  };
}

// --- Input ---

export interface GearPayoutRow {
  transactionId: string;
  userId: string;
  credits: number;
  paidAt: Date;
}

export type HeldGearStatus = 'held' | 'paid' | 'void' | 'paused';

export interface HeldGearRow {
  transactionId: string;
  userId: string;
  status: HeldGearStatus;
  heldAt: Date;
}

/** One AI usage ledger row; `credits` is the positive cost. */
export interface UsageRow {
  userId: string;
  model: string | null;
  credits: number;
  at: Date;
}

export interface AuditUser extends UserRecord {
  emailVerified?: boolean | null;
  /** Null on a verified account means a legacy row verified before the field was written. */
  emailVerifiedAt?: Date | null;
}

export interface GearOverrideRow {
  key: string;
  enabled?: boolean | null;
  credits?: number | null;
}

export interface GearGrantAuditInput {
  now: Date;
  days: number;
  withinDays: number;
  top: number;
  /** Gear payouts paid inside the window. */
  payouts: GearPayoutRow[];
  /** Gear HeldCreditReward rows held inside the window, or behind a payout in `payouts`. */
  held: HeldGearRow[];
  /** attributeSpend over the external recipients' payouts and usage, summed with addSpend. */
  spend: SpendAttribution;
  /** Payout owners plus every account created inside the window. */
  users: Map<string, AuditUser>;
  rules: ExclusionRules;
  activeGearKeys: string[];
  /** The freeTierAllowedModels admin setting; a model outside it counts as frontier. */
  freeTierModels: ReadonlySet<string>;
  /** The gearRewardMinAccountAgeDays admin setting as read now. */
  minAccountAgeDays: number;
  /** Owners with a live published artifact viewed by a signed-in non-owner. */
  externallyViewedPublishers: ReadonlySet<string>;
}

/** The gear key of a `gear-unlock:<userId>:<key>` transactionId. */
export const gearKeyOf = (transactionId: string): string => transactionId.slice(transactionId.lastIndexOf(':') + 1);

/** Catalog keys a user can claim now: not disabled and not overridden to zero credits in Manage Gears. */
export function activeGearKeys(allKeys: readonly string[], overrides: GearOverrideRow[]): string[] {
  const byKey = new Map(overrides.map(o => [o.key, o]));
  return allKeys.filter(key => byKey.get(key)?.enabled !== false && byKey.get(key)?.credits !== 0);
}

export type ModelTier = 'frontier' | 'standard' | 'unknown';

export function modelTier(model: string | null, freeTierModels: ReadonlySet<string>): ModelTier {
  if (!model) return 'unknown';
  return freeTierModels.has(model) ? 'standard' : 'frontier';
}

// --- Report ---

export interface GearRow {
  key: string;
  payouts: number;
  accounts: number;
  credits: number;
}

export interface AccountRow {
  userId: string;
  gears: number;
  credits: number;
}

export interface ClaimTierRow {
  gears: number;
  /** New external accounts that claimed at least `gears` active gears. */
  signups: number;
  /** Of those, the ones whose `gears`-th claim came within withinDays of signup. */
  within: number;
}

export interface ModelSpendRow {
  model: string;
  tier: ModelTier;
  credits: number;
}

export interface GearGrantReport {
  windowStart: string;
  now: string;
  days: number;
  withinDays: number;
  staffExclusionConfigured: boolean;
  excludedPayouts: number;
  payouts: { count: number; credits: number; accounts: number };
  perGear: GearRow[];
  perAccount: { mean: number | null; median: number | null; p90: number | null; max: number | null };
  topAccounts: AccountRow[];
  fastClaims: {
    activeGears: number;
    externalSignups: number;
    /** Ascending claim counts, the last being every active gear. */
    tiers: ClaimTierRow[];
  };
  spend: {
    gearCredits: number;
    spentAfterFirstPayout: number;
    gearAttributed: number;
    gearAttributedFrontier: number;
    gearAttributedUnknown: number;
    frontierShare: number | null;
    topModels: ModelSpendRow[];
  };
  checks: {
    minAccountAgeDays: number;
    payoutsChecked: number;
    claimedBelowMinAge: number;
    signupUnknown: number;
    claimedBeforeEmailVerified: number;
    publishedPayouts: number;
    publishedWithoutExternalView: number;
    heldByStatus: Record<HeldGearStatus, number>;
  };
}

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Nearest-rank percentile of an ascending list; null when it is empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Signup time, falling back to the ObjectId timestamp the way the gears catalog does for account age. */
function signupMs(userId: string, user: AuditUser): number {
  if (user.createdAt) return user.createdAt.getTime();
  return /^[0-9a-f]{24}$/i.test(userId) ? parseInt(userId.slice(0, 8), 16) * 1000 : NaN;
}

function wasVerifiedBy(user: AuditUser, at: Date): boolean {
  if (!user.emailVerified) return false;
  return !user.emailVerifiedAt || user.emailVerifiedAt <= at;
}

/**
 * Credits paid by gears and then spent, walked in time order per account: a payout adds to the
 * account's gear balance and each usage row draws from it first. Credits are fungible in the real
 * balance, so this is an attribution, not a record of which credits paid for what.
 */
export type SpendAttribution = Pick<
  GearGrantReport['spend'],
  'spentAfterFirstPayout' | 'gearAttributed' | 'gearAttributedFrontier' | 'gearAttributedUnknown'
> & {
  byModel: Map<string, number>;
};

export const emptySpend = (): SpendAttribution => ({
  spentAfterFirstPayout: 0,
  gearAttributed: 0,
  gearAttributedFrontier: 0,
  gearAttributedUnknown: 0,
  byModel: new Map(),
});

/** Adds `from` into `into`. Attribution is per account, so batches of whole accounts sum exactly. */
export function addSpend(into: SpendAttribution, from: SpendAttribution): SpendAttribution {
  into.spentAfterFirstPayout += from.spentAfterFirstPayout;
  into.gearAttributed += from.gearAttributed;
  into.gearAttributedFrontier += from.gearAttributedFrontier;
  into.gearAttributedUnknown += from.gearAttributedUnknown;
  for (const [model, credits] of from.byModel) into.byModel.set(model, (into.byModel.get(model) ?? 0) + credits);
  return into;
}

export function attributeSpend(
  payouts: GearPayoutRow[],
  usage: UsageRow[],
  freeTierModels: ReadonlySet<string>
): SpendAttribution {
  type Event = { at: number; order: number; payout?: GearPayoutRow; use?: UsageRow };
  const events = new Map<string, Event[]>();
  const push = (userId: string, event: Event) => {
    const list = events.get(userId) ?? [];
    list.push(event);
    events.set(userId, list);
  };
  for (const payout of payouts) push(payout.userId, { at: payout.paidAt.getTime(), order: 0, payout });
  for (const use of usage) if (events.has(use.userId)) push(use.userId, { at: use.at.getTime(), order: 1, use });

  const totals = { spentAfterFirstPayout: 0, gearAttributed: 0, gearAttributedFrontier: 0, gearAttributedUnknown: 0 };
  const byModel = new Map<string, number>();
  for (const list of events.values()) {
    list.sort((a, b) => a.at - b.at || a.order - b.order);
    let balance = 0;
    let started = false;
    for (const event of list) {
      if (event.payout) {
        balance += event.payout.credits;
        started = true;
        continue;
      }
      if (!started) continue;
      const use = event.use as UsageRow;
      totals.spentAfterFirstPayout += use.credits;
      const drawn = Math.min(balance, use.credits);
      if (drawn <= 0) continue;
      balance -= drawn;
      totals.gearAttributed += drawn;
      const tier = modelTier(use.model, freeTierModels);
      if (tier === 'frontier') totals.gearAttributedFrontier += drawn;
      if (tier === 'unknown') totals.gearAttributedUnknown += drawn;
      const model = use.model || '(no model)';
      byModel.set(model, (byModel.get(model) ?? 0) + drawn);
    }
  }
  return { ...totals, byModel };
}

export function buildGearGrantReport(input: GearGrantAuditInput): GearGrantReport {
  const { now, days, withinDays, users, rules, activeGearKeys: activeKeys, freeTierModels } = input;
  const windowStart = new Date(now.getTime() - days * MS_PER_DAY);
  const isExternal = (userId: string) => exclusionReason(users.get(userId), rules) === null;

  const payouts = input.payouts.filter(p => isExternal(p.userId));
  const held = input.held.filter(h => isExternal(h.userId));

  // Claim time: when a queued reward was held, else when its ledger row was written. A void or
  // paused queue entry was refused, so it is not a claim.
  const claims = new Map<string, { userId: string; key: string; at: Date }>();
  for (const p of payouts)
    claims.set(p.transactionId, { userId: p.userId, key: gearKeyOf(p.transactionId), at: p.paidAt });
  for (const h of held) {
    if (h.status !== 'held' && h.status !== 'paid') continue;
    const paid = claims.get(h.transactionId);
    if (!paid || h.heldAt < paid.at)
      claims.set(h.transactionId, { userId: h.userId, key: gearKeyOf(h.transactionId), at: h.heldAt });
  }

  const perGear = new Map<string, { payouts: number; accounts: Set<string>; credits: number }>();
  for (const key of activeKeys) perGear.set(key, { payouts: 0, accounts: new Set(), credits: 0 });
  const perAccount = new Map<string, AccountRow>();
  for (const p of payouts) {
    const key = gearKeyOf(p.transactionId);
    const gear = perGear.get(key) ?? { payouts: 0, accounts: new Set<string>(), credits: 0 };
    gear.payouts += 1;
    gear.accounts.add(p.userId);
    gear.credits += p.credits;
    perGear.set(key, gear);
    const account = perAccount.get(p.userId) ?? { userId: p.userId, gears: 0, credits: 0 };
    account.gears += 1;
    account.credits += p.credits;
    perAccount.set(p.userId, account);
  }
  const accountCredits = [...perAccount.values()].map(a => a.credits).sort((a, b) => a - b);
  const totalCredits = accountCredits.reduce((sum, c) => sum + c, 0);

  // Active gears claimed by accounts created inside the window.
  const activeSet = new Set(activeKeys);
  const claimTimesByUser = new Map<string, number[]>();
  for (const claim of claims.values()) {
    if (!activeSet.has(claim.key)) continue;
    const times = claimTimesByUser.get(claim.userId) ?? [];
    times.push(claim.at.getTime());
    claimTimesByUser.set(claim.userId, times);
  }
  const tierCounts = [...new Set([...CLAIM_TIERS.filter(n => n < activeKeys.length), activeKeys.length])]
    .filter(n => n > 0)
    .map(gears => ({ gears, signups: 0, within: 0 }));
  let externalSignups = 0;
  for (const [userId, user] of users) {
    if (!user.createdAt || user.createdAt < windowStart || !isExternal(userId)) continue;
    externalSignups += 1;
    const times = (claimTimesByUser.get(userId) ?? []).sort((a, b) => a - b);
    for (const tier of tierCounts) {
      if (times.length < tier.gears) continue;
      tier.signups += 1;
      if (times[tier.gears - 1] - user.createdAt.getTime() <= withinDays * MS_PER_DAY) tier.within += 1;
    }
  }

  const { spend } = input;

  const minAgeMs = input.minAccountAgeDays * MS_PER_DAY;
  let claimedBelowMinAge = 0;
  let signupUnknown = 0;
  let claimedBeforeEmailVerified = 0;
  let publishedPayouts = 0;
  let publishedWithoutExternalView = 0;
  for (const p of payouts) {
    const user = users.get(p.userId) as AuditUser;
    const at = (claims.get(p.transactionId) as { at: Date }).at;
    const createdMs = signupMs(p.userId, user);
    if (Number.isNaN(createdMs)) signupUnknown += 1;
    else if (at.getTime() - createdMs < minAgeMs) claimedBelowMinAge += 1;
    if (!wasVerifiedBy(user, at)) claimedBeforeEmailVerified += 1;
    if (gearKeyOf(p.transactionId) === 'published') {
      publishedPayouts += 1;
      if (!input.externallyViewedPublishers.has(p.userId)) publishedWithoutExternalView += 1;
    }
  }
  const heldByStatus: Record<HeldGearStatus, number> = { held: 0, paid: 0, void: 0, paused: 0 };
  for (const h of held) if (h.heldAt >= windowStart) heldByStatus[h.status] += 1;

  return {
    windowStart: windowStart.toISOString(),
    now: now.toISOString(),
    days,
    withinDays,
    staffExclusionConfigured: rules.staffEmail !== null,
    excludedPayouts: input.payouts.length - payouts.length,
    payouts: { count: payouts.length, credits: totalCredits, accounts: perAccount.size },
    perGear: [...perGear]
      .map(([key, g]) => ({ key, payouts: g.payouts, accounts: g.accounts.size, credits: g.credits }))
      .sort((a, b) => b.credits - a.credits || a.key.localeCompare(b.key)),
    perAccount: {
      mean: accountCredits.length === 0 ? null : totalCredits / accountCredits.length,
      median: percentile(accountCredits, 50),
      p90: percentile(accountCredits, 90),
      max: percentile(accountCredits, 100),
    },
    topAccounts: [...perAccount.values()]
      .sort((a, b) => b.credits - a.credits || a.userId.localeCompare(b.userId))
      .slice(0, input.top),
    fastClaims: { activeGears: activeKeys.length, externalSignups, tiers: tierCounts },
    spend: {
      gearCredits: totalCredits,
      spentAfterFirstPayout: spend.spentAfterFirstPayout,
      gearAttributed: spend.gearAttributed,
      gearAttributedFrontier: spend.gearAttributedFrontier,
      gearAttributedUnknown: spend.gearAttributedUnknown,
      frontierShare: share(spend.gearAttributedFrontier, spend.gearAttributed),
      topModels: [...spend.byModel]
        .map(([model, credits]) => ({
          model,
          credits,
          tier: modelTier(model === '(no model)' ? null : model, freeTierModels),
        }))
        .sort((a, b) => b.credits - a.credits || a.model.localeCompare(b.model))
        .slice(0, input.top),
    },
    checks: {
      minAccountAgeDays: input.minAccountAgeDays,
      payoutsChecked: payouts.length,
      claimedBelowMinAge,
      signupUnknown,
      claimedBeforeEmailVerified,
      publishedPayouts,
      publishedWithoutExternalView,
      heldByStatus,
    },
  };
}

// --- Markdown ---

const num = (value: number | null): string => (value === null ? 'n/a' : Math.round(value).toLocaleString('en-US'));
const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const table = (header: string[], rows: string[][]): string[] => [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map(row => `| ${row.join(' | ')} |`),
];

export function formatGearGrantReport(report: GearGrantReport): string {
  const { payouts, perAccount, fastClaims, spend, checks } = report;
  const lines: string[] = [
    '## Gear grant audit',
    '',
    `Window: ${report.windowStart} to ${report.now} (${report.days} days). External accounts only; ` +
      `${report.excludedPayouts} payout(s) to internal, test or unknown accounts excluded.`,
  ];
  if (!report.staffExclusionConfigured) {
    lines.push('', '> WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty, so no staff-domain exclusion was applied.');
  }

  lines.push(
    '',
    '### 1. Payouts',
    '',
    `${num(payouts.count)} payout(s), ${num(payouts.credits)} credits, ${num(payouts.accounts)} account(s).`,
    '',
    ...table(
      ['Gear', 'Payouts', 'Accounts', 'Credits'],
      report.perGear.map(g => [g.key, num(g.payouts), num(g.accounts), num(g.credits)])
    ),
    '',
    `Credits per account: mean ${num(perAccount.mean)}, median ${num(perAccount.median)}, ` +
      `p90 ${num(perAccount.p90)}, max ${num(perAccount.max)}.`,
    '',
    `Top ${report.topAccounts.length} account(s) by gear credits:`,
    '',
    ...table(
      ['Account', 'Gears', 'Credits'],
      report.topAccounts.map(a => [a.userId, num(a.gears), num(a.credits)])
    ),
    '',
    '### 2. Gears claimed by new accounts',
    '',
    `Of ${num(fastClaims.externalSignups)} external account(s) created in the window ` +
      `(${fastClaims.activeGears} active gears), how many claimed at least N active gears, and how many ` +
      `reached N within ${report.withinDays} day(s) of signup. A claim is timed by its queue entry when the ` +
      'reward was queued, else by its payout.',
    '',
    ...table(
      ['Gears claimed', 'Accounts', `Within ${report.withinDays} day(s)`],
      fastClaims.tiers.map(t => [
        t.gears === fastClaims.activeGears ? `all ${t.gears}` : `>= ${t.gears}`,
        num(t.signups),
        num(t.within),
      ])
    ),
    '',
    '### 3. Gear credits spent on frontier models',
    '',
    `Frontier share: ${pct(spend.frontierShare)} of ${num(spend.gearAttributed)} spent gear credits ` +
      `(${num(spend.gearAttributedFrontier)} frontier, ${num(spend.gearAttributedUnknown)} on rows with no model).`,
    '',
    `Gear credits paid: ${num(spend.gearCredits)}. Recipients' AI spend after their first gear payout: ` +
      `${num(spend.spentAfterFirstPayout)}. Each account's usage draws on its gear credits first, in time ` +
      'order; balances are fungible, so this is an attribution. Frontier means a model outside the ' +
      'freeTierAllowedModels admin setting.',
    '',
    ...table(
      ['Model', 'Tier', 'Gear credits spent'],
      spend.topModels.map(m => [m.model, m.tier, num(m.credits)])
    ),
    '',
    '### 4. Claim checks',
    '',
    'Each payout in the window measured against the current claim conditions (email verified, ' +
      'minimum account age, the published gear condition), plus the outcome of queued rewards. ' +
      'A declined claim writes no row, so it is not counted here.',
    '',
    ...table(
      ['Measure', 'Count'],
      [
        [
          `Payouts claimed before the account was ${checks.minAccountAgeDays} day(s) old (current gearRewardMinAccountAgeDays)`,
          num(checks.claimedBelowMinAge),
        ],
        ['Payouts to accounts with no signup date', num(checks.signupUnknown)],
        ['Payouts claimed before the email was verified', num(checks.claimedBeforeEmailVerified)],
        [
          `Published gear payouts with no externally viewed published artifact now (of ${num(checks.publishedPayouts)})`,
          num(checks.publishedWithoutExternalView),
        ],
        ['Queued gear rewards: held', num(checks.heldByStatus.held)],
        ['Queued gear rewards: paid on release', num(checks.heldByStatus.paid)],
        ['Queued gear rewards: void (refused at release)', num(checks.heldByStatus.void)],
        ['Queued gear rewards: paused (account blocked)', num(checks.heldByStatus.paused)],
      ]
    ),
    '',
    `Out of ${num(checks.payoutsChecked)} payout(s) checked. The minimum age is the setting's value now; ` +
      'a payout made under an earlier value is measured against the current one.'
  );
  return lines.join('\n');
}
