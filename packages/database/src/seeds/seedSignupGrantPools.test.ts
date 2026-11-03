import { describe, expect, it, vi } from 'vitest';
import { seedSignupGrantPoolsOnFirstBoot, type SignupGrantPoolSeedStore } from './seedSignupGrantPools';

const buildStore = (existing: Record<string, string> = {}) => {
  const findOne = vi.fn(async ({ settingName }: { settingName: string }) =>
    settingName in existing ? { settingValue: existing[settingName] } : null
  );
  const updateOne = vi.fn().mockResolvedValue(undefined);
  const store: SignupGrantPoolSeedStore = { findOne, updateOne };
  return { findOne, updateOne, store };
};

const writtenNames = (updateOne: ReturnType<typeof vi.fn>) =>
  updateOne.mock.calls.map(([filter]) => (filter as { settingName: string }).settingName);

describe('seedSignupGrantPoolsOnFirstBoot', () => {
  it('seeds both pools and returns true when neither pool row exists', async () => {
    const { store, updateOne } = buildStore({ signupGrantDailyBudget: '100' });

    await expect(seedSignupGrantPoolsOnFirstBoot(store)).resolves.toBe(true);

    expect(writtenNames(updateOne).sort()).toEqual(['signupGrantSignupPoolDaily', 'signupGrantTricklePoolDaily']);
  });

  it.each(['signupGrantSignupPoolDaily', 'signupGrantTricklePoolDaily'])(
    'returns false and writes nothing when %s already exists',
    async settingName => {
      const { store, updateOne } = buildStore({ [settingName]: '50', signupGrantDailyBudget: '100' });

      await expect(seedSignupGrantPoolsOnFirstBoot(store)).resolves.toBe(false);

      expect(updateOne).not.toHaveBeenCalled();
    }
  );
});
