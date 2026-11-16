import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STORAGE_LIMIT_MB } from '@bike4mind/common';
import type Stripe from 'stripe';
import { applyPlanStorageLimit, readPlanStorageLimit } from './applyPlanStorageLimit';

const { mockSetPlanStorageLimit } = vi.hoisted(() => ({ mockSetPlanStorageLimit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: { setPlanStorageLimit: mockSetPlanStorageLimit } }));
const { mockEmitMetric } = vi.hoisted(() => ({ mockEmitMetric: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: mockEmitMetric }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const subscriptionWithPriceMetadata = (metadata: Record<string, string>, status: Stripe.Subscription.Status) =>
  ({
    id: 'sub_1',
    status,
    items: { data: [{ price: { id: 'price_pro', metadata } }] },
  }) as unknown as Stripe.Subscription;

const apply = (metadata: Record<string, string>, status: Stripe.Subscription.Status = 'active') =>
  applyPlanStorageLimit(subscriptionWithPriceMetadata(metadata, status), 'user-1', logger as never);

describe('readPlanStorageLimit', () => {
  it.each([
    ['5000', 5000],
    [' 250 ', 250],
    [String(MAX_STORAGE_LIMIT_MB), MAX_STORAGE_LIMIT_MB],
  ])('reads %j as %d MB', (raw, limitMb) => {
    expect(readPlanStorageLimit({ storageLimitMb: raw })).toEqual({ kind: 'limit', limitMb });
  });

  it.each(['', 'abc', '10GB', '1.5', '-5', '0', '1e3', String(MAX_STORAGE_LIMIT_MB + 1)])('rejects %j', raw => {
    expect(readPlanStorageLimit({ storageLimitMb: raw })).toEqual({ kind: 'invalid', raw });
  });

  it('reports a price without the key, or without metadata, as absent', () => {
    expect(readPlanStorageLimit({ other: '1' })).toEqual({ kind: 'absent' });
    expect(readPlanStorageLimit(undefined)).toEqual({ kind: 'absent' });
  });
});

describe('applyPlanStorageLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetPlanStorageLimit.mockResolvedValue(true);
  });

  it('writes the price limit to the user', async () => {
    await apply({ storageLimitMb: '5000' });

    expect(mockSetPlanStorageLimit).toHaveBeenCalledWith('user-1', 5000);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('writes on a trialing subscription', async () => {
    await apply({ storageLimitMb: '5000' }, 'trialing');

    expect(mockSetPlanStorageLimit).toHaveBeenCalledWith('user-1', 5000);
  });

  it.each(['incomplete', 'past_due', 'unpaid', 'canceled', 'incomplete_expired', 'paused'] as const)(
    'does not grant the plan limit on a %s subscription',
    async status => {
      await apply({ storageLimitMb: '5000' }, status);

      expect(mockSetPlanStorageLimit).not.toHaveBeenCalled();
    }
  );

  it('leaves the limit unchanged when the price has no storageLimitMb', async () => {
    await apply({});

    expect(mockSetPlanStorageLimit).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves the limit unchanged and warns on an invalid value', async () => {
    await apply({ storageLimitMb: 'lots' });

    expect(mockSetPlanStorageLimit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('price_pro'), { raw: 'lots' });
  });

  it('warns when the user does not exist', async () => {
    mockSetPlanStorageLimit.mockResolvedValue(false);

    await apply({ storageLimitMb: '5000' });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('user-1'));
  });

  it('logs and swallows a write failure', async () => {
    const error = new Error('db down');
    mockSetPlanStorageLimit.mockRejectedValue(error);

    await expect(apply({ storageLimitMb: '5000' })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { error });
    expect(mockEmitMetric).toHaveBeenCalledWith('Lumina5/Entitlements', 'PlanStorageLimitFailed', 1, {
      reason: 'write_failed',
    });
  });
});
