import { carryLegacyGrantBudgetSpend } from '../models/auth/SignupGrantBudgetModel';

/** Seed for a pool when the retired signupGrantDailyBudget held no positive cap (0 used to mean unmetered). */
export const POOL_SEED_UNMETERED = 1_000_000_000;

export const SIGNUP_GRANT_POOL_SETTING_NAMES = {
  signup: 'signupGrantSignupPoolDaily',
  trickle: 'signupGrantTricklePoolDaily',
} as const;

/** A stored non-negative integer setting as a number; anything else reads as 0. */
const parseCreditSetting = (value: unknown): number => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const parsed = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(parsed) ? parsed : 0;
};

/**
 * The old cap metered signup grants and the drip together, so a positive cap is split between the pools
 * (sum <= old cap). A cap of 1 has no split without a 0 row, so the trickle row is left unwritten (paused).
 */
export function signupGrantPoolSeedValues(legacyBudget: unknown): { signup: number; trickle: number | null } {
  const parsed = parseCreditSetting(legacyBudget);
  if (parsed <= 0) return { signup: POOL_SEED_UNMETERED, trickle: POOL_SEED_UNMETERED };
  const trickle = Math.floor(parsed / 2);
  return { signup: parsed - trickle, trickle: trickle > 0 ? trickle : null };
}

export interface SignupGrantPoolSeedStore {
  findOne(filter: { settingName: string }): PromiseLike<{ settingValue?: unknown } | null>;
  updateOne(
    filter: { settingName: string },
    update: { $setOnInsert: { settingName: string; settingValue: string } },
    options: { upsert: true }
  ): PromiseLike<unknown>;
}

/**
 * Splits the old single daily cap across the signup-grant pools; a missing pool row reads as paused.
 * Never writes 0 and never touches an existing row. Shared by the hosted migration (packages/scripts/migrate) and the self-host worker boot
 * (apps/workers/src/selfhost/main.ts, once via runSeedOnce), which runs no migrations. Then moves today's
 * spend on the retired counter onto the pool counters (carryLegacyGrantBudgetSpend).
 */
export async function seedSignupGrantPools(store: SignupGrantPoolSeedStore, now: Date = new Date()): Promise<void> {
  const legacy = await store.findOne({ settingName: 'signupGrantDailyBudget' });
  const seeds = signupGrantPoolSeedValues(legacy?.settingValue);
  for (const pool of ['signup', 'trickle'] as const) {
    const value = seeds[pool];
    if (value === null) continue;
    const settingName = SIGNUP_GRANT_POOL_SETTING_NAMES[pool];
    await store.updateOne(
      { settingName },
      { $setOnInsert: { settingName, settingValue: String(value) } },
      { upsert: true }
    );
  }
  const [signup, trickle] = await Promise.all(
    (['signup', 'trickle'] as const).map(async pool =>
      parseCreditSetting((await store.findOne({ settingName: SIGNUP_GRANT_POOL_SETTING_NAMES[pool] }))?.settingValue)
    )
  );
  await carryLegacyGrantBudgetSpend({ signup, trickle }, now);
}
