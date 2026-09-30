import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import { AccountService, readBalance } from './AccountService';

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
