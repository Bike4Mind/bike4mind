import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  PAID_PLAN_ENTITLEMENT_KEY,
  ServiceUnavailableError,
} from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import { assertPaidFeatureAccess } from './paidFeatureAdmission';
import { isModelRequiresSubscriptionError } from './modelAdmission';

const input = (overrides: Partial<Parameters<typeof assertPaidFeatureAccess>[0]> = {}) => ({
  user: { isAdmin: false, tags: [] },
  planlessDeployment: false,
  getEntitlements: vi.fn(async () => [] as string[]),
  featureLabel: 'Video export',
  ...overrides,
});

describe('assertPaidFeatureAccess', () => {
  it('admits a paid-plan user', async () => {
    await expect(
      assertPaidFeatureAccess(input({ getEntitlements: async () => [PAID_PLAN_ENTITLEMENT_KEY] }))
    ).resolves.toBeUndefined();
  });

  it('refuses a free user with the paid-model ForbiddenError shape', async () => {
    const error = await assertPaidFeatureAccess(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).message).toBe('Video export requires a paid plan. Upgrade your plan to use it.');
    expect((error as ForbiddenError).additionalInfo?.errorCode).toBe(MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE);
    expect(isModelRequiresSubscriptionError(error)).toBe(true);
  });

  it.each([
    ['an admin', { isAdmin: true, tags: [] }],
    ['a developer-tagged user', { isAdmin: false, tags: ['developer'] }],
  ])('exempts %s without reading entitlements', async (_label, user) => {
    const getEntitlements = vi.fn(async () => [] as string[]);
    await expect(assertPaidFeatureAccess(input({ user, getEntitlements }))).resolves.toBeUndefined();
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  it('admits everyone on a planless (self-host) deployment', async () => {
    const getEntitlements = vi.fn(async () => [] as string[]);
    await expect(assertPaidFeatureAccess(input({ planlessDeployment: true, getEntitlements }))).resolves.toBeUndefined();
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  it('answers a failed entitlement read as retryable, not as an upgrade prompt', async () => {
    const error = await assertPaidFeatureAccess(
      input({
        getEntitlements: async () => {
          throw new Error('db down');
        },
      })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
  });
});
