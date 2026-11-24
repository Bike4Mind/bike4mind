import type { AccountPlan } from '@shared/account';
import type { UsageBar } from '@shared/usage';

export const DAY_MS = 86_400_000;

/**
 * Runway that fills the ring: one monthly period.
 *
 * The ring measures days of runway, not a share of the allowance, because unspent credits carry
 * over: a balance banked over several months is many times the allowance, and a percentage of it
 * would either overflow or sit pinned at full and say nothing. Runway is the question the user
 * actually has - "will I run out before the refill" - and it means the same on every plan.
 */
export const FULL_RUNWAY_DAYS = 30;
export const CRITICAL_RUNWAY_DAYS = 2;
/** With no refill coming, the warning starts a week out. */
export const LOW_RUNWAY_DAYS_WITHOUT_REFILL = 7;
export const BURN_WINDOW_DAYS = 7;

export type CreditTone = 'ok' | 'low' | 'critical';

type Projected = { tone: CreditTone; ringFill: number; burnPerDay: number; runwayDays: number; runsOutAt: number };

export type CreditOutlook =
  | { kind: 'unknown' }
  | { kind: 'empty'; tone: 'critical'; ringFill: 0; refillAt: number | null }
  /** No spend to project from: the ring stays an empty track rather than claiming plenty. */
  | { kind: 'idle'; tone: 'ok'; ringFill: 0; refillAt: number | null }
  | (Projected & { kind: 'covered'; refillAt: number })
  | (Projected & { kind: 'short'; refillAt: number; daysShort: number })
  | (Projected & { kind: 'no-refill' });

/**
 * Average daily spend over the daily bars that began in the last `BURN_WINDOW_DAYS` days.
 *
 * Divided by the time actually elapsed since the oldest bar counted began, so today's partial
 * day neither inflates nor dilutes the rate. Floored at one day, so the first hour of a new
 * account does not extrapolate a single reply into a daily rate.
 */
export function dailyBurn(bars: readonly UsageBar[], now: number): number {
  const recent = bars
    .map(bar => ({ at: Date.parse(bar.startsAt), spent: bar.creditsSpent }))
    .filter(bar => Number.isFinite(bar.at) && bar.at <= now && bar.at > now - BURN_WINDOW_DAYS * DAY_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, BURN_WINDOW_DAYS);
  if (recent.length === 0) return 0;
  const spent = recent.reduce((sum, bar) => sum + Math.max(0, bar.spent), 0);
  const elapsedDays = Math.max(1, (now - recent[recent.length - 1].at) / DAY_MS);
  return spent / elapsedDays;
}

/**
 * When the next personal credits arrive, or null when that is not known.
 *
 * Needs a stated monthly allowance as well as a monthly plan: the plan can be an org seat, whose
 * renewal tops up the org's pool, not this balance, and `/me` counts only personal grants in the
 * allowance. A yearly plan is not read as a refill: how its credits arrive across the year is not
 * stated by the API. A period end already passed means the renewal has not landed yet (a failed
 * payment, say), so it is not promised either.
 */
export function nextRefillAt(plan: AccountPlan | null, monthlyAllowance: number | null, now: number): number | null {
  if (!plan || plan.interval !== 'monthly' || !monthlyAllowance || monthlyAllowance <= 0) return null;
  const at = Date.parse(plan.currentPeriodEndsAt);
  return Number.isFinite(at) && at > now ? at : null;
}

/** Where the refill marker sits on the ring, 0..1 clockwise from the top. Null when unknown. */
export function refillMarker(refillAt: number | null, now: number): number | null {
  if (refillAt === null) return null;
  return Math.min(1, Math.max(0, (refillAt - now) / DAY_MS / FULL_RUNWAY_DAYS));
}

export function creditOutlook({
  balance,
  burnPerDay,
  refillAt,
  now,
}: {
  balance: number | null;
  burnPerDay: number;
  refillAt: number | null;
  now: number;
}): CreditOutlook {
  if (balance === null) return { kind: 'unknown' };
  if (balance <= 0) return { kind: 'empty', tone: 'critical', ringFill: 0, refillAt };
  if (burnPerDay <= 0) return { kind: 'idle', tone: 'ok', ringFill: 0, refillAt };

  const runwayDays = balance / burnPerDay;
  const runsOutAt = now + runwayDays * DAY_MS;
  const ringFill = Math.min(1, runwayDays / FULL_RUNWAY_DAYS);
  const critical = runwayDays < CRITICAL_RUNWAY_DAYS;
  const base = { burnPerDay, runwayDays, runsOutAt, ringFill };

  if (refillAt === null) {
    const tone: CreditTone = critical ? 'critical' : runwayDays < LOW_RUNWAY_DAYS_WITHOUT_REFILL ? 'low' : 'ok';
    return { ...base, kind: 'no-refill', tone };
  }
  if (runsOutAt >= refillAt) {
    return { ...base, kind: 'covered', tone: critical ? 'critical' : 'ok', refillAt };
  }
  const daysShort = Math.max(1, Math.ceil((refillAt - runsOutAt) / DAY_MS));
  return { ...base, kind: 'short', tone: critical ? 'critical' : 'low', refillAt, daysShort };
}

/**
 * "3 days", "2 weeks", "over a month". Coarse on purpose: a burn rate is an estimate.
 *
 * Capped at the ring's horizon: a longer claim would ignore that granted credits expire (90 days
 * for a subscription grant, see `stampCreditLot.ts`), which this projection cannot see yet.
 */
export function formatRunway(days: number): string {
  if (days < 1) return 'under a day';
  if (days < 14) return plural(Math.floor(days), 'day');
  if (days <= FULL_RUNWAY_DAYS) return plural(Math.round(days / 7), 'week');
  return 'over a month';
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
