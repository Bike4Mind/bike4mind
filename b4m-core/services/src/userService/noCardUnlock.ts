import { resolve as dnsResolve } from 'node:dns/promises';
import {
  CreditHolderType,
  IAdminSettingsRepository,
  ICacheRepository,
  ICreditLotRepository,
  ICreditTransactionRepository,
  IUserDocument,
  IUserRepository,
  isBlockedPhone,
  NO_CARD_UNLOCK_REASONS,
  noCardUnlockTransactionId,
  personalEmailProviders,
  regionalPersonalEmailProviders,
  resolveNoCardUnlockSettings,
  type NoCardUnlockReason,
  type NoCardUnlockRefusal,
  type NoCardUnlockSettings,
  type SignupProtection,
} from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService/addCredits';
import { accountBlockReasons } from './accountState';
import { isDisposableEmail } from './disposableEmail';
import { protectSignupCredits } from './signupProtection';
import { reserveSignupGrantBudget, type SignupGrantBudgetReservation } from './signupGrantBudget';

/** `reasonGranted`: this user already holds a ledger row for the reason, e.g. a concurrent request won the grant. */
export type NoCardUnlockRelease = (opts: { reasonGranted: boolean }) => Promise<void>;

export type NoCardUnlockCommit =
  { ok: true; release: NoCardUnlockRelease } | { ok: false; refusal: NoCardUnlockRefusal };

/** `commit` consumes a scarce resource (a GitHub id, a domain slot); the grant calls it only after the final decision. */
export type NoCardUnlockCheck =
  { ok: true; commit?: () => Promise<NoCardUnlockCommit> } | { ok: false; refusal: NoCardUnlockRefusal };

export interface NoCardUnlockUser {
  id: string;
  email: string;
}

export type NoCardUnlockValidator = (user: NoCardUnlockUser) => Promise<NoCardUnlockCheck>;

export type GithubProfile = { id: number; login: string; created_at: string; public_repos: number };
export type GithubEmail = { email: string; verified: boolean; primary: boolean };

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly rateLimited = false
  ) {
    super(`GitHub API responded ${status}`);
    this.name = 'GithubApiError';
  }
}

export interface GithubClient {
  getUser(token: string): Promise<GithubProfile>;
  getEmails(token: string): Promise<GithubEmail[]>;
}

const REAUTHORIZE_STATUSES = new Set([401, 403, 404]);
const DAY_MS = 24 * 60 * 60 * 1000;

const deny = (refusal: NoCardUnlockRefusal): NoCardUnlockCheck => ({ ok: false, refusal });

export interface GithubValidatorDeps {
  settings: NoCardUnlockSettings;
  github: GithubClient;
  getAccessToken: (userId: string) => Promise<string | null>;
  claimGithubId: (githubId: number, userId: string) => Promise<{ claimed: boolean }>;
  releaseGithubId: (githubId: number, userId: string) => Promise<void>;
  now?: () => Date;
}

export function githubValidator(deps: GithubValidatorDeps): NoCardUnlockValidator {
  return async user => {
    if (deps.settings.githubMinAgeDays <= 0 || deps.settings.githubMinRepos <= 0) return deny('disabled');

    const token = await deps.getAccessToken(user.id);
    if (!token) return deny('github_not_linked');

    let profile: GithubProfile;
    let emails: GithubEmail[];
    try {
      profile = await deps.github.getUser(token);
      emails = await deps.github.getEmails(token);
    } catch (error) {
      if (error instanceof GithubApiError && error.rateLimited) return deny('github_rate_limited');
      if (error instanceof GithubApiError && REAUTHORIZE_STATUSES.has(error.status)) {
        return deny('github_reauthorize_required');
      }
      throw error;
    }

    if (typeof profile.id !== 'number' || !Number.isSafeInteger(profile.id)) return deny('github_not_linked');

    const createdAt = Date.parse(profile.created_at);
    const ageDays = Number.isNaN(createdAt) ? -1 : ((deps.now?.() ?? new Date()).getTime() - createdAt) / DAY_MS;
    if (ageDays < 0 || ageDays < deps.settings.githubMinAgeDays) return deny('github_too_new');
    if (typeof profile.public_repos !== 'number' || profile.public_repos < deps.settings.githubMinRepos) {
      return deny('github_few_repos');
    }
    if (!Array.isArray(emails) || !emails.some(e => e.verified === true)) return deny('github_email_unverified');

    const githubId = profile.id;
    return {
      ok: true,
      commit: async () => {
        const claim = await deps.claimGithubId(githubId, user.id);
        if (!claim.claimed) return { ok: false, refusal: 'github_already_claimed' };
        // The claim is per (id, user), so a concurrent winner for this user relies on the same row.
        return {
          ok: true,
          release: async ({ reasonGranted }) => {
            if (!reasonGranted) await deps.releaseGithubId(githubId, user.id);
          },
        };
      },
    };
  };
}

export interface WorkEmailValidatorDeps {
  settings: NoCardUnlockSettings;
  cache: Pick<ICacheRepository, 'tryIncrementWithinLimitFixedWindow' | 'decrementCounter'>;
  resolveMx?: (domain: string) => Promise<unknown[]>;
  /** true = domain accepts any local part, false = it rejects unknown ones, null = could not tell. */
  catchAllProbe: (domain: string) => Promise<boolean | null>;
  now?: () => Date;
  isDisposable?: (email: string) => boolean;
}

const defaultResolveMx = (domain: string) => dnsResolve(domain, 'MX');

export function workEmailValidator(deps: WorkEmailValidatorDeps): NoCardUnlockValidator {
  const { settings } = deps;
  const resolveMx = deps.resolveMx ?? defaultResolveMx;
  const isDisposable = deps.isDisposable ?? isDisposableEmail;

  return async user => {
    const email = (user.email ?? '').trim().toLowerCase();
    const at = email.lastIndexOf('@');
    const domain = at > 0 ? email.slice(at + 1) : '';
    const registrable = registrableDomain(domain);
    if (!domain || !registrable) return deny('work_email_no_mx');

    const free: readonly string[] = [...personalEmailProviders, ...regionalPersonalEmailProviders];
    if (free.includes(domain) || free.includes(registrable)) return deny('work_email_free');
    if (isDisposable(email)) return deny('work_email_disposable');

    let mx: unknown[] = [];
    try {
      mx = await resolveMx(domain);
    } catch {
      mx = [];
    }
    if (!Array.isArray(mx) || mx.length === 0) return deny('work_email_no_mx');

    let catchAll: boolean | null = null;
    try {
      catchAll = await deps.catchAllProbe(domain);
    } catch {
      catchAll = null;
    }
    if (catchAll === true) return deny('work_email_catch_all');
    if (catchAll === null && !settings.probeInconclusiveAllows) return deny('work_email_probe_inconclusive');

    const cap = settings.workEmailDomainDailyCap;
    if (cap <= 0) return deny('domain_cap_reached');
    const key = `no-card-unlock:domain:${registrable}`;
    return {
      ok: true,
      commit: async () => {
        const { success, expiresAt } = await deps.cache.tryIncrementWithinLimitFixedWindow(key, cap, DAY_MS);
        if (!success) return { ok: false, refusal: 'domain_cap_reached' };
        // A slot taken in a window that has since rolled over is already gone; decrementing would refund another user's.
        return {
          ok: true,
          release: async () => {
            if (expiresAt.getTime() > (deps.now?.() ?? new Date()).getTime()) await deps.cache.decrementCounter(key);
          },
        };
      },
    };
  };
}

export interface PhoneValidatorDeps {
  settings: NoCardUnlockSettings;
  code: string;
  /** The E.164 number the start step sent a code to for this user, or null when none is pending. */
  getPendingPhone: (userId: string) => Promise<string | null>;
  checkCode: (phone: string, code: string) => Promise<boolean>;
  claimPhone: (phone: string, userId: string) => Promise<{ claimed: boolean }>;
  releasePhone: (phone: string, userId: string) => Promise<void>;
}

export function phoneValidator(deps: PhoneValidatorDeps): NoCardUnlockValidator {
  return async user => {
    const phone = await deps.getPendingPhone(user.id);
    if (!phone) return deny('phone_not_started');
    // Re-checked here because a range can be blocked between sending the code and entering it.
    if (isBlockedPhone(phone, deps.settings.phoneBlockedPrefixes)) return deny('phone_blocked');
    if (!(await deps.checkCode(phone, deps.code))) return deny('phone_code_invalid');

    return {
      ok: true,
      commit: async () => {
        const claim = await deps.claimPhone(phone, user.id);
        if (!claim.claimed) return { ok: false, refusal: 'phone_already_claimed' };
        return {
          ok: true,
          release: async ({ reasonGranted }) => {
            if (!reasonGranted) await deps.releasePhone(phone, user.id);
          },
        };
      },
    };
  };
}

const SETTING_NAMES = [
  'noCardUnlockEnabled',
  'noCardUnlockGithubCredits',
  'noCardUnlockWorkEmailCredits',
  'noCardUnlockMaxCredits',
  'noCardUnlockGithubMinAgeDays',
  'noCardUnlockGithubMinRepos',
  'noCardUnlockWorkEmailDomainDailyCap',
  'noCardUnlockProbeInconclusiveAllows',
  'noCardUnlockPhoneEnabled',
  'noCardUnlockPhoneCredits',
  'noCardUnlockPhoneBlockedPrefixes',
  'noCardUnlockPhoneAsnDailyCap',
  'noCardUnlockPhoneCountryDailyCap',
] as const;

export async function loadNoCardUnlockSettings(
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>
): Promise<NoCardUnlockSettings> {
  const rows = await Promise.all(SETTING_NAMES.map(name => adminSettings.findBySettingName(name)));
  const raw: Record<string, unknown> = {};
  SETTING_NAMES.forEach((name, i) => {
    raw[name] = rows[i]?.settingValue;
  });
  return resolveNoCardUnlockSettings(raw);
}

export type GrantNoCardUnlockResult =
  { granted: true; credits: number; currentCredits: number } | { granted: false; refusal: NoCardUnlockRefusal };

export interface GrantNoCardUnlockAdapters {
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName' | 'findBySettingNames'>;
    creditTransactions: ICreditTransactionRepository;
    creditLots: ICreditLotRepository;
    users: IUserRepository;
  };
  validators: Record<NoCardUnlockReason, NoCardUnlockValidator>;
  withTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
  settings?: NoCardUnlockSettings;
  signupProtection?: SignupProtection;
}

const refused = (refusal: NoCardUnlockRefusal): GrantNoCardUnlockResult => ({ granted: false, refusal });

function reasonCreditsOf(reason: NoCardUnlockReason, settings: NoCardUnlockSettings): number {
  const credits: Record<NoCardUnlockReason, number> = {
    github_verified: settings.githubCredits,
    work_email_verified: settings.workEmailCredits,
    phone_verified: settings.phoneEnabled ? settings.phoneCredits : 0,
  };
  return credits[reason];
}

type EligibilityAdapters = Pick<GrantNoCardUnlockAdapters, 'db' | 'settings' | 'signupProtection'>;

type Preflight =
  | { ok: true; user: IUserDocument; settings: NoCardUnlockSettings; reasonCredits: number; transactionId: string }
  | { ok: false; refusal: NoCardUnlockRefusal };

/** The account-level checks every reason shares, run before any validator so a refusal costs nothing external. */
async function preflight(
  userId: string,
  reason: NoCardUnlockReason,
  { db, settings: preloaded, signupProtection }: EligibilityAdapters
): Promise<Preflight> {
  const settings = preloaded ?? (await loadNoCardUnlockSettings(db.adminSettings));
  if (!settings.enabled) return { ok: false, refusal: 'disabled' };

  const reasonCredits = reasonCreditsOf(reason, settings);
  if (reasonCredits <= 0) return { ok: false, refusal: 'disabled' };

  const user = await db.users.findById(userId);
  if (!user || !user.emailVerified || accountBlockReasons(user).length > 0) return { ok: false, refusal: 'disabled' };

  const transactionId = noCardUnlockTransactionId(reason, userId);
  if (await db.creditTransactions.findOne({ transactionId })) return { ok: false, refusal: 'already_granted' };

  if (await protectSignupCredits(userId, { users: db.users, adminSettings: db.adminSettings, signupProtection })) {
    return { ok: false, refusal: 'signup_held' };
  }
  return { ok: true, user, settings, reasonCredits, transactionId };
}

export type NoCardUnlockEligibility = { eligible: true } | { eligible: false; refusal: NoCardUnlockRefusal };

/**
 * Whether a grant for `reason` could succeed if its validator passed. For a reason whose validator
 * costs money (the phone unlock sends an SMS), call this first so an ineligible user spends nothing.
 */
export async function noCardUnlockEligibility(
  userId: string,
  reason: NoCardUnlockReason,
  adapters: EligibilityAdapters
): Promise<NoCardUnlockEligibility> {
  const pre = await preflight(userId, reason, adapters);
  if (!pre.ok) return { eligible: false, refusal: pre.refusal };
  const granted = await sumGranted(adapters.db, userId);
  if (Math.min(pre.reasonCredits, pre.settings.maxCredits - granted) <= 0) {
    return { eligible: false, refusal: 'cap_reached' };
  }
  return { eligible: true };
}

export async function grantNoCardUnlock(
  userId: string,
  reason: NoCardUnlockReason,
  { db, validators, withTransaction, settings: preloaded, signupProtection }: GrantNoCardUnlockAdapters
): Promise<GrantNoCardUnlockResult> {
  const pre = await preflight(userId, reason, { db, settings: preloaded, signupProtection });
  if (!pre.ok) return refused(pre.refusal);
  const { user, settings, reasonCredits, transactionId } = pre;

  // A budget-held signup tranche is paid before any unlock, so no account holds the remainder without it.
  if (user.signupGrantHeldReason === 'budget_exhausted') return refused('signup_grant_pending');

  const check = await validators[reason]({ id: user.id, email: user.email ?? '' });
  if (!check.ok) return refused(check.refusal);

  const grantedBefore = await sumGranted(db, userId);
  if (Math.min(reasonCredits, settings.maxCredits - grantedBefore) <= 0) return refused('cap_reached');

  const commit = check.commit ? await check.commit() : null;
  if (commit && !commit.ok) return refused(commit.refusal);

  let result: GrantNoCardUnlockResult | null = null;
  let failure: unknown = null;
  let paidByPeer = false;
  const reservations: SignupGrantBudgetReservation[] = [];
  try {
    result = await withTransaction(async () => {
      const current = await db.users.findById(userId);
      if (!current || accountBlockReasons(current).length > 0) return refused('disabled');

      const granted = await sumGranted(db, userId);
      const amount = Math.min(reasonCredits, settings.maxCredits - granted);
      if (amount <= 0) return refused('cap_reached');

      const reservation = await reserveSignupGrantBudget(
        { adminSettings: db.adminSettings, signupProtection },
        transactionId,
        amount
      );
      reservations.push(reservation);
      if (reservation.outcome === 'exhausted') return refused('daily_budget_reached');

      const { creditHolder } = await addCreditsWithLedgerRow(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: amount,
          type: 'generic_add',
          transactionId,
          reason: `no_card_unlock:${reason}`,
        },
        {
          db: { creditTransactions: db.creditTransactions, creditLots: db.creditLots },
          creditHolderMethods: db.users,
          duplicateTransactionId: 'throw',
        }
      );
      return { granted: true, credits: amount, currentCredits: creditHolder.currentCredits };
    });
  } catch (error) {
    if (error instanceof DuplicateCreditTransactionError) {
      result = refused('already_granted');
      paidByPeer = true;
    } else failure = error;
  }
  // A duplicate ledger row means a concurrent grant paid under this id, so its draw stays spent.
  if (!result?.granted && !paidByPeer) await Promise.all(reservations.map(held => held.release()));
  if (commit?.ok && !result?.granted) {
    try {
      const reasonGranted = Boolean(await db.creditTransactions.findOne({ transactionId }));
      await commit.release({ reasonGranted });
    } catch (releaseError) {
      throw failure ?? releaseError;
    }
  }
  if (failure) throw failure;
  return result as GrantNoCardUnlockResult;
}

async function sumGranted(db: GrantNoCardUnlockAdapters['db'], userId: string): Promise<number> {
  let granted = 0;
  for (const other of NO_CARD_UNLOCK_REASONS) {
    const row = await db.creditTransactions.findOne({ transactionId: noCardUnlockTransactionId(other, userId) });
    granted += row?.credits ?? 0;
  }
  return granted;
}
