import { describe, expect, it, vi } from 'vitest';
import type { SignupProtection } from '@bike4mind/common';
import { refundBudgetOnFailure, reserveSignupGrantBudget } from './signupGrantBudget';

const buildAdapters = (overrides: Partial<NonNullable<SignupProtection['grantBudget']>> = {}, budget = '20') => {
  const repository = {
    reserve: vi.fn().mockResolvedValue({ spent: 10, fresh: true }),
    refund: vi.fn().mockResolvedValue(undefined),
    markAlerted: vi.fn().mockResolvedValue(true),
    getSpent: vi.fn().mockResolvedValue(17),
  };
  const adapters = {
    adminSettings: { findBySettingName: vi.fn().mockResolvedValue({ settingValue: budget }) },
    signupProtection: { repository: {}, grantBudget: { repository, ...overrides } },
  };
  return { repository, adapters: adapters as unknown as Parameters<typeof reserveSignupGrantBudget>[0] };
};

describe('refundBudgetOnFailure', () => {
  it('refunds a reservation made inside fn when fn throws, and rethrows', async () => {
    const { repository, adapters } = buildAdapters();
    const failure = new Error('payout aborted');
    await expect(
      refundBudgetOnFailure(async () => {
        await reserveSignupGrantBudget(adapters, 'tx-1', 10);
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(repository.refund).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'tx-1', 10);
  });

  it('keeps the reservation when fn resolves', async () => {
    const { repository, adapters } = buildAdapters();
    await refundBudgetOnFailure(() => reserveSignupGrantBudget(adapters, 'tx-1', 10));
    expect(repository.refund).not.toHaveBeenCalled();
  });

  it('does not touch a reservation made outside the scope', async () => {
    const { repository, adapters } = buildAdapters();
    await reserveSignupGrantBudget(adapters, 'outside', 10);
    await expect(
      refundBudgetOnFailure(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(repository.refund).not.toHaveBeenCalled();
  });
});

describe('budget alerts', () => {
  it('reports the real spend on the exhausted 100% alert', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { repository, adapters } = buildAdapters({ notify });
    repository.reserve.mockResolvedValue(null);

    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 10);

    expect(result.outcome).toBe('exhausted');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ threshold: 100, spent: 17, budget: 20 }));
  });

  it('does not wait for a notify that never resolves', async () => {
    const notify = vi.fn().mockReturnValue(new Promise(() => {}));
    const { adapters } = buildAdapters({ notify });
    await expect(reserveSignupGrantBudget(adapters, 'tx-1', 10)).resolves.toMatchObject({ outcome: 'reserved' });
    expect(notify).toHaveBeenCalled();
  });
});
