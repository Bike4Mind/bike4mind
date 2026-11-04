import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ userIndexes: vi.fn(), rewardIndexes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { createIndexes: models.userIndexes },
  ReferralSubscriptionRewardModel: { createIndexes: models.rewardIndexes },
}));
import migration from './20260921238300_ensure-referral-inviter-indexes';

describe('referral inviter indexes migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds the user and reward indexes', async () => {
    await migration.up();
    expect(models.userIndexes).toHaveBeenCalledExactlyOnceWith();
    expect(models.rewardIndexes).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([['userIndexes'], ['rewardIndexes']] as const)(
    'propagates a %s build failure so the migration remains retryable',
    async name => {
      models[name].mockRejectedValueOnce(new Error('index build failed'));
      await expect(migration.up()).rejects.toThrow('index build failed');
    }
  );

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    expect(models.userIndexes).not.toHaveBeenCalled();
    expect(models.rewardIndexes).not.toHaveBeenCalled();
  });
});
