import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks, balance } = vi.hoisted(() => {
  process.env.B4M_SELF_HOST = 'false';
  return {
    balance: { current: 0, failRefund: false },
    mocks: {
      getSettingsMap: vi.fn(),
      createTransaction: vi.fn(),
    },
  };
});

// An in-memory user whose incrementCredits is atomic, like the Mongo $inc it stands in for.
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  organizationRepository: {},
  creditTransactionRepository: { createTransaction: (...a: unknown[]) => mocks.createTransaction(...a) },
  userRepository: {
    findById: async (id: string) => ({ id, currentCredits: balance.current }),
    incrementCredits: async (id: string, delta: number) => {
      if (delta > 0 && balance.failRefund) throw new Error('mongo blip');
      balance.current += delta;
      return { id, currentCredits: balance.current };
    },
  },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

import { holdPreflightCredits, InsufficientCreditsPreflightError } from './creditPreflight';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const hold = (estimatedCredits: number) =>
  holdPreflightCredits({
    userId: 'u1',
    estimatedCredits,
    featureLabel: 'text-to-speech',
    logger: logger as never,
  });
const entry = { type: 'text_to_speech_usage' as const, model: 'tts-1', sessionId: 's1' };

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  logger.error.mockClear();
  mocks.getSettingsMap.mockResolvedValue({});
  mocks.createTransaction.mockResolvedValue(undefined);
  balance.failRefund = false;
});

describe('holdPreflightCredits', () => {
  it('admits only the calls the balance covers when they run concurrently, so it never goes negative', async () => {
    balance.current = 10;

    const results = await Promise.allSettled([hold(6), hold(6), hold(6)]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(r => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsPreflightError);
    }
    expect(balance.current).toBe(4);
  });

  it('settles the measured cost against the hold and refunds the rest', async () => {
    balance.current = 10;
    const held = await hold(6);

    await expect(held.settle(4, entry)).resolves.toBe(4);

    expect(balance.current).toBe(6);
    expect(mocks.createTransaction).toHaveBeenCalledWith(
      'text_to_speech_usage',
      expect.objectContaining({ ownerId: 'u1', credits: -4, model: 'tts-1' })
    );
  });

  it('never charges past the hold, whatever the settlement asks for', async () => {
    balance.current = 6;
    const held = await hold(6);

    await expect(held.settle(50, entry)).resolves.toBe(6);
    expect(balance.current).toBe(0);
  });

  it('keeps the whole hold, and still writes its ledger row, on a non-finite charge', async () => {
    balance.current = 10;
    const held = await hold(6);

    await expect(held.settle(NaN, entry)).resolves.toBe(6);

    expect(balance.current).toBe(4);
    expect(mocks.createTransaction).toHaveBeenCalledWith(
      'text_to_speech_usage',
      expect.objectContaining({ credits: -6 })
    );
  });

  it('still writes the ledger row when the over-reserve refund fails', async () => {
    balance.current = 10;
    const held = await hold(6);
    balance.failRefund = true;

    await expect(held.settle(4, entry)).resolves.toBe(4);

    expect(mocks.createTransaction).toHaveBeenCalledWith(
      'text_to_speech_usage',
      expect.objectContaining({ credits: -4 })
    );
  });

  it('returns the whole hold when the provider call fails', async () => {
    balance.current = 10;
    const held = await hold(6);

    await held.release();

    expect(balance.current).toBe(10);
    expect(mocks.createTransaction).not.toHaveBeenCalled();
  });

  it('holds nothing with enforcement off and charges on settle, as these routes always have', async () => {
    mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });
    balance.current = 0;
    const held = await hold(6);
    expect(balance.current).toBe(0);

    await expect(held.settle(6, entry)).resolves.toBe(6);
    expect(balance.current).toBe(-6);
  });

  it('resolves the charge when the ledger write rejects, so a delivered result is not failed by billing', async () => {
    balance.current = 10;
    const held = await hold(6);
    mocks.createTransaction.mockRejectedValueOnce(new Error('ledger write failed'));

    await expect(held.settle(4, entry)).resolves.toBe(4);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('settlement failed'), expect.anything());
  });

  it('resolves release when the refund write rejects, so the provider error still reaches the caller', async () => {
    balance.current = 10;
    const held = await hold(6);
    balance.failRefund = true;

    await expect(held.release()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('refund failed'), expect.anything());
  });
});
