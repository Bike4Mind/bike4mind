import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isBlankSettingValue,
  settingsMap,
  type IAdminSettingsRepository,
  type SignupGrantBudgetThreshold,
  type SignupGrantPool,
  type SignupProtection,
} from '@bike4mind/common';

type BudgetAdapters = {
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>;
  signupProtection?: SignupProtection;
};

export type SignupGrantBudgetReservation = {
  outcome: 'unmetered' | 'reserved' | 'exhausted';
  /** False when this transaction id already held a draw, i.e. another attempt owns it and may still refund it. */
  fresh?: boolean;
  /** Releases a 'reserved' hold when the payout did not commit. Safe to call more than once. */
  release: () => Promise<void>;
};

const noop = async () => {};

const refundScope = new AsyncLocalStorage<Array<() => Promise<void>>>();
// Fresh draws made inside a refundBudgetOnFailure scope, by counter key and transaction id, so a
// transaction retry inside that scope still recognises its own earlier draw as fresh.
const scopeDraws = new WeakMap<Array<() => Promise<void>>, Map<string, () => Promise<void>>>();

/**
 * Hands back every budget draw made inside `fn` if it throws. The counter commits outside any ambient
 * transaction, so a caller that rolls the payouts back (e.g. a losing invite redemption) must refund it.
 */
export async function refundBudgetOnFailure<T>(fn: () => Promise<T>): Promise<T> {
  const releases: Array<() => Promise<void>> = [];
  try {
    return await refundScope.run(releases, fn);
  } catch (error) {
    await Promise.all(releases.map(release => release()));
    throw error;
  }
}

const POOL_SETTING = {
  signup: 'signupGrantSignupPoolDaily',
  trickle: 'signupGrantTricklePoolDaily',
} as const satisfies Record<SignupGrantPool, keyof typeof settingsMap>;

/**
 * A pool's daily budget. An absent, blank or invalid row resolves to 0 with `missing` set, so the pool
 * pauses (and alerts) rather than paying unmetered; an explicit 0 also pauses but is not missing.
 */
export async function resolvePoolBudget(
  adminSettings: BudgetAdapters['adminSettings'],
  pool: SignupGrantPool
): Promise<{ budget: number; missing: boolean }> {
  const key = POOL_SETTING[pool];
  const raw = (await adminSettings.findBySettingName(key))?.settingValue;
  if (isBlankSettingValue(raw)) return { budget: 0, missing: true };
  const parsed = settingsMap[key].schema.safeParse(raw);
  return parsed.success ? { budget: parsed.data, missing: false } : { budget: 0, missing: true };
}

export const signupGrantBudgetDay = (now: Date = new Date()) => now.toISOString().slice(0, 10);

type HeldRewardQueue = NonNullable<NonNullable<SignupProtection['grantBudget']>['heldRewards']>;

/** The budget counter's storage key for one pool-day; read spend with this, never a bare day. */
export const signupGrantBudgetKey = (pool: SignupGrantPool, day: string) => `${pool}:${day}`;

async function alertCrossing(
  budgetConfig: NonNullable<SignupProtection['grantBudget']>,
  pool: SignupGrantPool,
  day: string,
  threshold: SignupGrantBudgetThreshold,
  readSpent: () => Promise<number>,
  budget: number
) {
  try {
    if (await budgetConfig.repository.markAlerted(signupGrantBudgetKey(pool, day), threshold)) {
      const spent = await readSpent();
      // Reservations run inside callers' payout transactions and Slack can take seconds.
      budgetConfig.notify?.({ pool, day, threshold, spent, budget })?.catch(error => {
        console.warn('[signup-grant-budget] Budget alert failed', error);
      });
    }
  } catch (error) {
    console.warn('[signup-grant-budget] Budget alert failed', error);
  }
}

/**
 * True when a newer grant must wait behind the queue: the pool's day could no longer cover the oldest
 * held reward that fits the daily budget once `amount` is drawn. No queue, or no wired budget, never
 * blocks. Rewards larger than the whole budget are passed over (releaseHeldCreditRewards skips them the
 * same way), so the head is the oldest reward the release can actually pay.
 */
export async function queueHeadBlocks(
  adapters: BudgetAdapters,
  pool: SignupGrantPool,
  heldRewards: HeldRewardQueue | undefined,
  amount: number,
  dayOverride?: string
): Promise<boolean> {
  const budgetConfig = adapters.signupProtection?.grantBudget;
  if (!budgetConfig || !heldRewards) return false;
  const day = dayOverride ?? signupGrantBudgetDay(budgetConfig.now?.());
  const { budget } = await resolvePoolBudget(adapters.adminSettings, pool);
  const oldestHeld = await heldRewards.oldestHeldCredits(budget > 0 ? budget : undefined);
  if (!oldestHeld) return false;
  const spent = await budgetConfig.repository.getSpent(signupGrantBudgetKey(pool, day));
  return budget - spent < oldestHeld + amount;
}

/**
 * Draws `amount` credits from today's budget for `pool`. A pool at 0, or with a missing or invalid
 * setting, is 'exhausted' (missing also alerts once per pool-day).
 * 'unmetered' remains only for a non-positive amount or when no counter is wired. `day` pins the draw
 * to a caller-chosen UTC day so a payout keyed by that day books against it.
 */
export async function reserveSignupGrantBudget(
  adapters: BudgetAdapters,
  transactionId: string,
  amount: number,
  { pool, day: dayOverride }: { pool: SignupGrantPool; day?: string }
): Promise<SignupGrantBudgetReservation> {
  const budgetConfig = adapters.signupProtection?.grantBudget;
  if (!budgetConfig || amount <= 0) return { outcome: 'unmetered', release: noop };
  const day = dayOverride ?? signupGrantBudgetDay(budgetConfig.now?.());
  const key = signupGrantBudgetKey(pool, day);
  const readSpent = () => budgetConfig.repository.getSpent(key);
  const { budget, missing } = await resolvePoolBudget(adapters.adminSettings, pool);
  if (missing) await alertCrossing(budgetConfig, pool, day, 'missing', readSpent, 0);
  if (budget <= 0) return { outcome: 'exhausted', release: noop };

  const reservation = await budgetConfig.repository.reserve(key, transactionId, amount, budget);
  if (!reservation) {
    await alertCrossing(budgetConfig, pool, day, 100, readSpent, budget);
    return { outcome: 'exhausted', release: noop };
  }
  const scope = refundScope.getStore();
  const drawKey = `${key}|${transactionId}`;
  const ownDraw = !reservation.fresh && scope ? scopeDraws.get(scope)?.get(drawKey) : undefined;
  if (ownDraw) return { outcome: 'reserved', release: ownDraw, fresh: true };
  const reservedSpent = async () => reservation.spent;
  if (reservation.spent * 2 >= budget) await alertCrossing(budgetConfig, pool, day, 50, reservedSpent, budget);
  if (reservation.spent >= budget) await alertCrossing(budgetConfig, pool, day, 100, reservedSpent, budget);
  const release = !reservation.fresh
    ? noop
    : () =>
        budgetConfig.repository.refund(key, transactionId, amount).catch(error => {
          console.warn('[signup-grant-budget] Refund failed; the day may under-report remaining budget', error);
        });
  if (scope && reservation.fresh) {
    scope.push(release);
    const draws = scopeDraws.get(scope) ?? new Map<string, () => Promise<void>>();
    draws.set(drawKey, release);
    scopeDraws.set(scope, draws);
  }
  return { outcome: 'reserved', release, fresh: reservation.fresh };
}
