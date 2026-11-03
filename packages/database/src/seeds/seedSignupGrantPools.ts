/** Seed for a pool when the retired signupGrantDailyBudget held no positive cap (0 used to mean unmetered). */
export const POOL_SEED_UNMETERED = 1_000_000_000;

export const SIGNUP_GRANT_POOL_SETTING_NAMES = ['signupGrantSignupPoolDaily', 'signupGrantTricklePoolDaily'] as const;

export function signupGrantPoolSeedValue(legacyBudget: unknown): number {
  const text =
    typeof legacyBudget === 'number'
      ? String(legacyBudget)
      : typeof legacyBudget === 'string'
        ? legacyBudget.trim()
        : '';
  const parsed = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : POOL_SEED_UNMETERED;
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
 * Gives each signup-grant pool the old single daily cap, so nothing newly pauses when the pools
 * replace it; a missing pool row reads as paused. Never writes 0 and never touches an existing
 * row. Shared by the hosted migration (packages/scripts/migrate) and the self-host worker boot
 * (apps/workers/src/selfhost/main.ts), which runs no migrations.
 */
export async function seedSignupGrantPools(store: SignupGrantPoolSeedStore): Promise<void> {
  const legacy = await store.findOne({ settingName: 'signupGrantDailyBudget' });
  const settingValue = String(signupGrantPoolSeedValue(legacy?.settingValue));
  for (const settingName of SIGNUP_GRANT_POOL_SETTING_NAMES) {
    await store.updateOne({ settingName }, { $setOnInsert: { settingName, settingValue } }, { upsert: true });
  }
}
