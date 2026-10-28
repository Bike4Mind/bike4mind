import { describe, expect, it, vi } from 'vitest';

const { release } = vi.hoisted(() => ({ release: vi.fn<() => Promise<{ failed: number }>>() }));
vi.mock('@server/referrals/subscriptionReward', () => ({ releaseDueSubscriptionRewards: release }));

import { registerReferralRewardRelease } from './referralRewardRelease';
import type { SelfHostWorker } from './selfHostWorker';

const ONE_HOUR_MS = 60 * 60_000;

const register = () => {
  const registerScheduledTask = vi.fn<SelfHostWorker['registerScheduledTask']>();
  registerReferralRewardRelease({ registerScheduledTask });
  const registration = registerScheduledTask.mock.calls[0];
  if (!registration) throw new Error('Referral reward release was not registered');
  return registration;
};

describe('local referral reward release schedule', () => {
  it('registers an hourly task that also runs at startup', () => {
    const [name, interval, , options] = register();
    expect({ name, interval, options }).toEqual({
      name: 'referralRewardRelease',
      interval: ONE_HOUR_MS,
      options: { runOnStartup: true },
    });
  });

  it('rejects when some rewards failed to release, so the runner logs it and re-arms', async () => {
    const [, , task] = register();
    release.mockResolvedValueOnce({ failed: 2 });
    await expect(task()).rejects.toThrow('Failed to release 2 referral reward(s)');
  });

  it('resolves when every due reward was handled', async () => {
    const [, , task] = register();
    release.mockResolvedValueOnce({ failed: 0 });
    await expect(task()).resolves.toBeUndefined();
  });
});
