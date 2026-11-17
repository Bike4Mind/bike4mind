import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearPlanStorageLimit: vi.fn(),
  hasOtherGrantingUserSubscription: vi.fn(),
  emitMetric: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { clearPlanStorageLimit: mocks.clearPlanStorageLimit } }));
vi.mock('../models/Subscription', () => ({
  subscriptionRepository: { hasOtherGrantingUserSubscription: mocks.hasOtherGrantingUserSubscription },
}));
vi.mock('../utils/cloudwatch', () => ({ emitMetric: mocks.emitMetric }));

import { endsPlanStorageAllowance, releasePlanStorageLimit } from './releasePlanStorageLimit';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('endsPlanStorageAllowance', () => {
  it.each(['canceled', 'incomplete_expired'] as const)('ends the allowance on %s', status => {
    expect(endsPlanStorageAllowance(status)).toBe(true);
  });

  it.each(['active', 'trialing', 'incomplete', 'past_due', 'unpaid', 'paused'] as const)(
    'keeps the allowance on %s, which Stripe can still bring back',
    status => {
      expect(endsPlanStorageAllowance(status)).toBe(false);
    }
  );
});

describe('releasePlanStorageLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasOtherGrantingUserSubscription.mockResolvedValue(false);
    mocks.clearPlanStorageLimit.mockResolvedValue(true);
  });

  it('clears the plan limit when no other subscription is live', async () => {
    await releasePlanStorageLimit('user-1', 'sub_old', logger);

    expect(mocks.hasOtherGrantingUserSubscription).toHaveBeenCalledWith('user-1', 'sub_old');
    expect(mocks.clearPlanStorageLimit).toHaveBeenCalledWith('user-1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the limit while another subscription still grants it (plan switch)', async () => {
    mocks.hasOtherGrantingUserSubscription.mockResolvedValue(true);

    await releasePlanStorageLimit('user-1', 'sub_old', logger);

    expect(mocks.clearPlanStorageLimit).not.toHaveBeenCalled();
  });

  it('warns when the user does not exist', async () => {
    mocks.clearPlanStorageLimit.mockResolvedValue(false);

    await releasePlanStorageLimit('user-1', 'sub_old', logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('user-1'));
  });

  it('logs, counts and swallows a failure', async () => {
    const error = new Error('db down');
    mocks.clearPlanStorageLimit.mockRejectedValue(error);

    await expect(releasePlanStorageLimit('user-1', 'sub_old', logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { error });
    expect(mocks.emitMetric).toHaveBeenCalledWith('Lumina5/Entitlements', 'PlanStorageLimitFailed', 1, {
      reason: 'clear_failed',
    });
  });
});
