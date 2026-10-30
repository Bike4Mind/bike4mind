import { AsyncLocalStorage } from 'node:async_hooks';
import { settingsMap, type IAdminSettingsRepository, type SignupProtection } from '@bike4mind/common';

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

export const signupGrantBudgetDay = (now: Date = new Date()) => now.toISOString().slice(0, 10);

async function alertCrossing(
  budgetConfig: NonNullable<SignupProtection['grantBudget']>,
  day: string,
  threshold: 50 | 100,
  readSpent: () => Promise<number>,
  budget: number
) {
  try {
    if (await budgetConfig.repository.markAlerted(day, threshold)) {
      const spent = await readSpent();
      // Reservations run inside callers' payout transactions and Slack can take seconds.
      budgetConfig.notify?.({ day, threshold, spent, budget })?.catch(error => {
        console.warn('[signup-grant-budget] Budget alert failed', error);
      });
    }
  } catch (error) {
    console.warn('[signup-grant-budget] Budget alert failed', error);
  }
}

/**
 * Draws `amount` credits from today's signup grant budget. 'unmetered' when no budget is configured
 * (the setting is 0, missing or invalid, or no counter is wired), which keeps that path unchanged.
 * `dayOverride` pins the draw to a caller-chosen UTC day so a payout keyed by that day books against it.
 */
export async function reserveSignupGrantBudget(
  adapters: BudgetAdapters,
  transactionId: string,
  amount: number,
  dayOverride?: string
): Promise<SignupGrantBudgetReservation> {
  const budgetConfig = adapters.signupProtection?.grantBudget;
  if (!budgetConfig || amount <= 0) return { outcome: 'unmetered', release: noop };
  const setting = await adapters.adminSettings.findBySettingName('signupGrantDailyBudget');
  const parsed = settingsMap.signupGrantDailyBudget.schema.safeParse(setting?.settingValue ?? 0);
  const budget = parsed.success ? parsed.data : 0;
  if (budget <= 0) return { outcome: 'unmetered', release: noop };

  const day = dayOverride ?? signupGrantBudgetDay(budgetConfig.now?.());
  const reservation = await budgetConfig.repository.reserve(day, transactionId, amount, budget);
  if (!reservation) {
    await alertCrossing(budgetConfig, day, 100, () => budgetConfig.repository.getSpent(day), budget);
    return { outcome: 'exhausted', release: noop };
  }
  if (reservation.spent * 2 >= budget) await alertCrossing(budgetConfig, day, 50, async () => reservation.spent, budget);
  if (reservation.spent >= budget) await alertCrossing(budgetConfig, day, 100, async () => reservation.spent, budget);
  const release = !reservation.fresh
    ? noop
    : () =>
        budgetConfig.repository.refund(day, transactionId, amount).catch(error => {
          console.warn('[signup-grant-budget] Refund failed; the day may under-report remaining budget', error);
        });
  refundScope.getStore()?.push(release);
  return { outcome: 'reserved', release, fresh: reservation.fresh };
}
