import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import { AccountService, readBalance, readPlan, readTier } from './AccountService';

function service(get: ReturnType<typeof vi.fn>, signedIn = true) {
  return new AccountService({
    logger: { warn: () => {} },
    getApiClient: () => (signedIn ? ({ get } as unknown as AuthenticatedApiClient) : null),
  });
}

describe('readBalance', () => {
  it('reads the balance the endpoint states', () => {
    expect(readBalance({ credits: { balance: 31_667 } })).toBe(31_667);
  });

  // Zero is a real balance and has to survive the parse as one; everything that is not a
  // usable number is "not stated", which the caller reports as unknown.
  it('keeps a zero and rejects anything that is not a usable number', () => {
    expect(readBalance({ credits: { balance: 0 } })).toBe(0);
    expect(readBalance({ credits: { balance: Number.NaN } })).toBeNull();
    expect(readBalance({ credits: { balance: '31667' } })).toBeNull();
    expect(readBalance({ credits: {} })).toBeNull();
    expect(readBalance(null)).toBeNull();
  });
});

describe('AccountService', () => {
  it('reports the balance from the account endpoint', async () => {
    const get = vi.fn().mockResolvedValue({ credits: { balance: 31_667 } });
    await expect(service(get).credits()).resolves.toEqual({ balance: 31_667 });
    expect(get).toHaveBeenCalledWith('/api/v1/me');
  });

  it('reports a zero balance as the real figure it is', async () => {
    const get = vi.fn().mockResolvedValue({ credits: { balance: 0 } });
    await expect(service(get).credits()).resolves.toEqual({ balance: 0 });
  });

  // The distinction the whole nullable balance exists for: a read that failed must not come
  // back looking like an account with nothing left.
  it('reports a failed read as unknown, with a reason, never as zero', async () => {
    const get = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const credits = await service(get).credits();
    expect(credits.balance).toBeNull();
    expect(credits.error).toBeTruthy();
  });

  it('does not reach the network at all when signed out', async () => {
    const get = vi.fn();
    const credits = await service(get, false).credits();
    expect(credits.balance).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent asks, and reads again after they settle', async () => {
    const get = vi.fn().mockResolvedValue({ credits: { balance: 12 } });
    const account = service(get);

    await Promise.all([account.credits(), account.credits()]);
    expect(get).toHaveBeenCalledTimes(1);

    // No TTL: the next ask is a fresh read, because it only comes after a turn has spent.
    await account.credits();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('readPlan', () => {
  const plan = {
    plan_name: 'Professional',
    price_id: 'price_1',
    interval: 'monthly',
    current_period_ends_at: '2026-10-18T00:00:00.000Z',
  };

  it('reads the subscription the endpoint states', () => {
    expect(readPlan({ subscription: plan })).toEqual({
      name: 'Professional',
      interval: 'monthly',
      currentPeriodEndsAt: '2026-10-18T00:00:00.000Z',
    });
  });

  // A row reading "renews Invalid Date" is worse than no row at all.
  it('reports no plan at all rather than a half-stated one', () => {
    expect(readPlan({ subscription: { ...plan, current_period_ends_at: 'soon' } })).toBeNull();
    expect(readPlan({ subscription: { ...plan, interval: 'weekly' } })).toBeNull();
    expect(readPlan({ subscription: { ...plan, plan_name: '' } })).toBeNull();
    expect(readPlan({ subscription: null })).toBeNull();
    expect(readPlan(null)).toBeNull();
  });
});

describe('readTier', () => {
  it('keeps a tier the ladder knows and discards anything else', () => {
    expect(readTier({ tier: 'pro' })).toBe('pro');
    expect(readTier({ tier: 'platinum' })).toBeNull();
    expect(readTier({})).toBeNull();
  });
});

describe('AccountService.profile', () => {
  // `other` is a paying account whose plan this deployment cannot name. Collapsing it into the
  // null plan would tell a paying customer they are on the free one.
  it('keeps the tier when the server names no plan', async () => {
    const get = vi.fn().mockResolvedValue({ credits: { balance: 10 }, tier: 'other', subscription: null });
    await expect(service(get).profile()).resolves.toEqual({
      credits: { balance: 10 },
      plan: null,
      tier: 'other',
    });
  });

  it('reads balance and plan from one request, not two', async () => {
    const get = vi.fn().mockResolvedValue({ credits: { balance: 10 }, tier: 'free', subscription: null });
    const account = service(get);
    await Promise.all([account.credits(), account.profile()]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
