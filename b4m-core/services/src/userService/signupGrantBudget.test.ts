import { describe, expect, it, vi } from 'vitest';
import type { SignupProtection } from '@bike4mind/common';
import {
  drawnInRefundScope,
  refundBudgetOnFailure,
  reserveSignupGrantBudget,
  resolvePoolBudget,
} from './signupGrantBudget';

const SIGNUP = { pool: 'signup' } as const;

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
        await reserveSignupGrantBudget(adapters, 'tx-1', 10, SIGNUP);
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(repository.refund).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^signup:/), 'tx-1', 10);
  });

  it('keeps the reservation when fn resolves', async () => {
    const { repository, adapters } = buildAdapters();
    await refundBudgetOnFailure(() => reserveSignupGrantBudget(adapters, 'tx-1', 10, SIGNUP));
    expect(repository.refund).not.toHaveBeenCalled();
  });

  it('does not touch a reservation made outside the scope', async () => {
    const { repository, adapters } = buildAdapters();
    await reserveSignupGrantBudget(adapters, 'outside', 10, SIGNUP);
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

    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 10, SIGNUP);

    expect(result.outcome).toBe('exhausted');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ pool: 'signup', threshold: 100, spent: 17, budget: 20 })
    );
  });

  it('does not wait for a notify that never resolves', async () => {
    const notify = vi.fn().mockReturnValue(new Promise(() => {}));
    const { adapters } = buildAdapters({ notify });
    await expect(reserveSignupGrantBudget(adapters, 'tx-1', 10, SIGNUP)).resolves.toMatchObject({
      outcome: 'reserved',
    });
    expect(notify).toHaveBeenCalled();
  });
});

describe('resolvePoolBudget', () => {
  const settingsWith = (rows: Record<string, unknown>) => ({
    findBySettingName: vi.fn(async (key: string) => (key in rows ? { settingValue: rows[key] } : null)),
  });

  it('reads each pool from its own key', async () => {
    const settings = settingsWith({ signupGrantSignupPoolDaily: '500', signupGrantTricklePoolDaily: 40 });
    await expect(resolvePoolBudget(settings as never, 'signup')).resolves.toEqual({ budget: 500, missing: false });
    await expect(resolvePoolBudget(settings as never, 'trickle')).resolves.toEqual({ budget: 40, missing: false });
  });

  it('treats an explicit 0 as paused, not missing', async () => {
    const settings = settingsWith({ signupGrantSignupPoolDaily: '0' });
    await expect(resolvePoolBudget(settings as never, 'signup')).resolves.toEqual({ budget: 0, missing: false });
  });

  it.each([undefined, null, '', '  ', '-1', '1.5', 'abc'])('pauses and flags missing for %j', async value => {
    const settings = settingsWith(value === undefined ? {} : { signupGrantTricklePoolDaily: value });
    await expect(resolvePoolBudget(settings as never, 'trickle')).resolves.toEqual({ budget: 0, missing: true });
  });

  it('ignores the retired single daily budget', async () => {
    const settings = settingsWith({ signupGrantDailyBudget: '1000' });
    await expect(resolvePoolBudget(settings as never, 'signup')).resolves.toEqual({ budget: 0, missing: true });
  });
});

describe('per-pool reservations', () => {
  const DAY = '2030-01-01';

  it('keys the counter by pool and day, so pools never share a spend', async () => {
    const { repository, adapters } = buildAdapters();
    await reserveSignupGrantBudget(adapters, 'tx-s', 5, { pool: 'signup', day: DAY });
    await reserveSignupGrantBudget(adapters, 'tx-t', 5, { pool: 'trickle', day: DAY });
    expect(repository.reserve.mock.calls.map(call => call[0])).toEqual([`signup:${DAY}`, `trickle:${DAY}`]);
  });

  it('reads only the requested pool setting', async () => {
    const { adapters } = buildAdapters();
    await reserveSignupGrantBudget(adapters, 'tx-t', 5, { pool: 'trickle', day: DAY });
    const keys = vi.mocked(adapters.adminSettings.findBySettingName).mock.calls.map(call => call[0]);
    expect(keys).toEqual(['signupGrantTricklePoolDaily']);
  });

  it('is exhausted without drawing when the pool is set to 0, and does not alert', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { repository, adapters } = buildAdapters({ notify }, '0');
    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 5, SIGNUP);
    expect(result.outcome).toBe('exhausted');
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([null, '', 'abc', '-3'])('pauses and alerts missing for a %j pool setting', async value => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { repository, adapters } = buildAdapters({ notify }, value as string);
    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 5, { pool: 'trickle', day: DAY });
    expect(result.outcome).toBe('exhausted');
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(repository.markAlerted).toHaveBeenCalledExactlyOnceWith(`trickle:${DAY}`, 'missing');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ pool: 'trickle', day: DAY, threshold: 'missing' }));
  });

  it('alerts missing once per pool-day', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { repository, adapters } = buildAdapters({ notify }, '');
    repository.markAlerted.mockResolvedValueOnce(true).mockResolvedValue(false);
    await reserveSignupGrantBudget(adapters, 'tx-1', 5, SIGNUP);
    await reserveSignupGrantBudget(adapters, 'tx-2', 5, SIGNUP);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('tags the 50% and 100% alerts with the pool that crossed them', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { repository, adapters } = buildAdapters({ notify });
    repository.reserve.mockResolvedValue({ spent: 20, fresh: true });
    await reserveSignupGrantBudget(adapters, 'tx-1', 5, { pool: 'trickle', day: DAY });
    expect(repository.markAlerted.mock.calls).toEqual([
      [`trickle:${DAY}`, 50],
      [`trickle:${DAY}`, 100],
    ]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ pool: 'trickle', threshold: 100 }));
  });

  it('never refunds a reservation another attempt owns', async () => {
    const { repository, adapters } = buildAdapters();
    repository.reserve.mockResolvedValue({ spent: 10, fresh: false });
    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 5, SIGNUP);
    await result.release();
    expect(result.fresh).toBe(false);
    expect(repository.refund).not.toHaveBeenCalled();
  });

  it('refunds a fresh reservation against the same pool key', async () => {
    const { repository, adapters } = buildAdapters();
    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 5, { pool: 'trickle', day: DAY });
    await result.release();
    expect(repository.refund).toHaveBeenCalledExactlyOnceWith(`trickle:${DAY}`, 'tx-1', 5);
  });

  it('refunds a fresh reservation once however often it is released', async () => {
    const { repository, adapters } = buildAdapters();
    const result = await reserveSignupGrantBudget(adapters, 'tx-1', 5, { pool: 'trickle', day: DAY });
    await result.release();
    await result.release();
    expect(repository.refund).toHaveBeenCalledTimes(1);
  });
});

describe('drawnInRefundScope', () => {
  it('sees a fresh draw of the same pool and transaction only while it stands inside the scope', async () => {
    const { adapters } = buildAdapters();
    expect(drawnInRefundScope(adapters, 'trickle', 'tx-1')).toBe(false);

    await refundBudgetOnFailure(async () => {
      expect(drawnInRefundScope(adapters, 'trickle', 'tx-1')).toBe(false);
      const reservation = await reserveSignupGrantBudget(adapters, 'tx-1', 5, { pool: 'trickle' });

      expect(drawnInRefundScope(adapters, 'trickle', 'tx-1')).toBe(true);
      expect(drawnInRefundScope(adapters, 'signup', 'tx-1')).toBe(false);
      expect(drawnInRefundScope(adapters, 'trickle', 'tx-2')).toBe(false);

      await reservation.release();
      expect(drawnInRefundScope(adapters, 'trickle', 'tx-1')).toBe(false);
    });

    expect(drawnInRefundScope(adapters, 'trickle', 'tx-1')).toBe(false);
  });
});
