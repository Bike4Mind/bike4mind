import { insufficientCreditsError, type IAdminSettingsRepository, type IUserDocument } from '@bike4mind/common';
import type { ILogger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

/**
 * Spend-velocity cap for young accounts, paid or not: stolen-card credits are only worth stealing if
 * they can be burned before the chargeback lands. Applies to the user's own credits (bought or
 * granted). Org-billed usage is exempt: the org pool has its own per-member caps, and its owner,
 * not the member, answers for the spend.
 *
 * Every credit hold calls this before any balance moves: holdCredits (creditHold.ts), the completion
 * holds (apps/client/server/billing/completionCreditHolds.ts), ChatCompletionProcess's inline
 * reservation, the agent executor's iteration gate and voice session holds.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SETTING_NAMES = [
  'enforceCredits',
  'newAccountSpendCapDays',
  'newAccountHourlySpendCapCredits',
  'newAccountDailySpendCapCredits',
] as const;

/** Credits spent at `at`: a settled ledger bucket or a hold still outstanding. */
export type SpendSample = { at: Date; credits: number };

export type NewAccountSpendCapAdapters = {
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
  /** Settled AI spend on the user's own credits since `since`, plus their holds not yet settled. */
  personalSpendSince(userId: string, since: Date): Promise<SpendSample[]>;
};

export type NewAccountSpendCapUser = Pick<IUserDocument, 'id' | 'createdAt' | 'isAdmin' | 'newAccountSpendCapLifted'>;

export type SpendCapLimits = { hourlyCredits: number; dailyCredits: number };

export type NewAccountSpendCapRefusal = {
  window: 'hour' | 'day';
  capCredits: number;
  spentCredits: number;
  /** When enough spend ages out of the window for this request to fit; null when it never can. */
  resetsAt: Date | null;
};

const WINDOWS = [
  { window: 'hour', ms: HOUR_MS, limit: 'hourlyCredits' },
  { window: 'day', ms: DAY_MS, limit: 'dailyCredits' },
] as const;

function refusalFor(
  samples: SpendSample[],
  requestedCredits: number,
  now: Date,
  window: (typeof WINDOWS)[number],
  capCredits: number
): NewAccountSpendCapRefusal | null {
  if (capCredits <= 0) return null;
  const windowStart = now.getTime() - window.ms;
  const inWindow = samples.filter(sample => sample.at.getTime() > windowStart).sort((a, b) => +a.at - +b.at);
  const spentCredits = inWindow.reduce((sum, sample) => sum + sample.credits, 0);
  if (spentCredits + requestedCredits <= capCredits) return null;

  let resetsAt: Date | null = null;
  if (requestedCredits <= capCredits) {
    let remaining = spentCredits;
    for (const sample of inWindow) {
      remaining -= sample.credits;
      if (remaining + requestedCredits <= capCredits) {
        // Ledger samples are floored to the minute: the next whole minute never promises a reset too early.
        resetsAt = new Date(Math.floor((sample.at.getTime() + window.ms) / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
        break;
      }
    }
  }
  return { window: window.window, capCredits, spentCredits, resetsAt };
}

/** Pure decision: the binding window's refusal (the one that frees up last), or null to allow. */
export function evaluateSpendWindows(params: {
  samples: SpendSample[];
  requestedCredits: number;
  now: Date;
  limits: SpendCapLimits;
}): NewAccountSpendCapRefusal | null {
  const { samples, requestedCredits, now, limits } = params;
  const refusals = WINDOWS.map(window =>
    refusalFor(samples, requestedCredits, now, window, limits[window.limit])
  ).filter((refusal): refusal is NewAccountSpendCapRefusal => refusal !== null);
  if (refusals.length === 0) return null;
  return refusals.reduce((binding, refusal) => {
    if (binding.resetsAt === null) return binding;
    if (refusal.resetsAt === null) return refusal;
    return refusal.resetsAt > binding.resetsAt ? refusal : binding;
  });
}

const formatCredits = (credits: number) => Math.ceil(credits).toLocaleString('en-US');

function formatResetTime(resetsAt: Date, now: Date): string {
  const time = `${String(resetsAt.getUTCHours()).padStart(2, '0')}:${String(resetsAt.getUTCMinutes()).padStart(2, '0')} UTC`;
  if (resetsAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return time;
  const day = resetsAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${day}, ${time}`;
}

export function newAccountSpendCapMessage(
  refusal: NewAccountSpendCapRefusal,
  requestedCredits: number,
  now: Date
): string {
  const limit = `New accounts can spend up to ${formatCredits(refusal.capCredits)} credits per ${refusal.window}`;
  if (refusal.resetsAt === null) {
    return `${limit}, and this request needs about ${formatCredits(requestedCredits)}. Try a smaller model or a shorter request.`;
  }
  return `${limit}; this resets at ${formatResetTime(refusal.resetsAt, now)}.`;
}

/** True when the user is young enough to be capped and nothing exempts them. Does not read spend. */
export function isNewAccountSpendCapped(user: NewAccountSpendCapUser, accountAgeDays: number, now: Date): boolean {
  if (accountAgeDays <= 0 || user.isAdmin || user.newAccountSpendCapLifted) return false;
  // A legacy account without createdAt predates the cap.
  if (!user.createdAt) return false;
  return now.getTime() - new Date(user.createdAt).getTime() < accountAgeDays * DAY_MS;
}

/**
 * The refusal message when `requestedCredits` would take a young account over its hourly or daily
 * cap, else null. Counts settled spend, outstanding holds and the request itself, so one large
 * request cannot jump the cap.
 */
export async function checkNewAccountSpendCap(
  params: {
    user: NewAccountSpendCapUser;
    requestedCredits: number;
    /** Org-billed usage follows the org's own limits. */
    billedToOrganization: boolean;
    logger?: ILogger;
    now?: Date;
  },
  adapters: NewAccountSpendCapAdapters
): Promise<string | null> {
  const { user, requestedCredits, billedToOrganization, logger } = params;
  if (billedToOrganization || requestedCredits <= 0) return null;
  const now = params.now ?? new Date();

  const settings = await getSettingsMap(adapters, { names: [...SETTING_NAMES] });
  if (getSettingsValue('enforceCredits', settings) !== true) return null;
  const accountAgeDays = getSettingsValue('newAccountSpendCapDays', settings) ?? 0;
  if (!isNewAccountSpendCapped(user, accountAgeDays, now)) return null;
  const limits: SpendCapLimits = {
    hourlyCredits: getSettingsValue('newAccountHourlySpendCapCredits', settings) ?? 0,
    dailyCredits: getSettingsValue('newAccountDailySpendCapCredits', settings) ?? 0,
  };
  if (limits.hourlyCredits <= 0 && limits.dailyCredits <= 0) return null;

  const samples = await adapters.personalSpendSince(user.id, new Date(now.getTime() - DAY_MS));
  const refusal = evaluateSpendWindows({ samples, requestedCredits, now, limits });
  if (!refusal) return null;

  logger?.warn('[NEW_ACCOUNT_SPEND_CAP] Request refused', {
    userId: user.id,
    window: refusal.window,
    capCredits: refusal.capCredits,
    spentCredits: refusal.spentCredits,
    requestedCredits,
    resetsAt: refusal.resetsAt?.toISOString() ?? null,
  });
  return newAccountSpendCapMessage(refusal, requestedCredits, now);
}

/** checkNewAccountSpendCap, throwing the 422 `insufficient_credits` every hold path already surfaces. */
export async function assertNewAccountSpendWithinCap(
  params: Parameters<typeof checkNewAccountSpendCap>[0],
  adapters: NewAccountSpendCapAdapters
): Promise<void> {
  const message = await checkNewAccountSpendCap(params, adapters);
  if (message) throw insufficientCreditsError(message);
}
