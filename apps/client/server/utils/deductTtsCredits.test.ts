import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findById: vi.fn(),
    subtractCredits: vi.fn(),
    recordUsage: vi.fn(),
    computeTtsUsd: vi.fn(),
    usdToCredits: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', () => ({
  CreditHolderType: { User: 'User' },
  computeTtsUsd: (...a: unknown[]) => mocks.computeTtsUsd(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  usdToCredits: (...a: unknown[]) => mocks.usdToCredits(...a),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { subtractCredits: (...a: unknown[]) => mocks.subtractCredits(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
  creditTransactionRepository: {},
  usageEventRepository: { record: (...a: unknown[]) => mocks.recordUsage(...a) },
}));

import { assertTtsCreditsAvailable, deductTtsCredits, InsufficientTtsCreditsError } from './deductTtsCredits';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.subtractCredits.mockResolvedValue(undefined);
});

describe('assertTtsCreditsAvailable', () => {
  it('throws InsufficientTtsCreditsError when the user is not found', async () => {
    mocks.findById.mockResolvedValue(null);
    await expect(assertTtsCreditsAvailable('u1')).rejects.toBeInstanceOf(InsufficientTtsCreditsError);
  });

  it('throws when the balance is zero or negative', async () => {
    mocks.findById.mockResolvedValue({ currentCredits: 0 });
    await expect(assertTtsCreditsAvailable('u1')).rejects.toThrow(/Insufficient credits/);
  });

  it('resolves when the user has a positive balance', async () => {
    mocks.findById.mockResolvedValue({ currentCredits: 1 });
    await expect(assertTtsCreditsAvailable('u1')).resolves.toBeUndefined();
  });

  it('treats a missing currentCredits field as zero balance', async () => {
    mocks.findById.mockResolvedValue({});
    await expect(assertTtsCreditsAvailable('u1')).rejects.toBeInstanceOf(InsufficientTtsCreditsError);
  });
});

describe('deductTtsCredits', () => {
  const args = {
    userId: 'u1',
    vendor: 'elevenlabs' as const,
    model: 'eleven_multilingual_v2',
    characters: 100,
    logger,
  };

  it('charges the computed credits and records a usage event on success', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);

    await deductTtsCredits(args);

    expect(mocks.computeTtsUsd).toHaveBeenCalledWith('elevenlabs', 'eleven_multilingual_v2', 100);
    expect(mocks.subtractCredits).toHaveBeenCalledTimes(1);
    expect(mocks.subtractCredits.mock.calls[0][0]).toMatchObject({
      type: 'text_to_speech_usage',
      ownerId: 'u1',
      ownerType: 'User',
      credits: 5,
      model: 'eleven_multilingual_v2',
    });
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      feature: 'text_to_speech',
      provider: 'elevenlabs',
      units: 100,
      costUsd: 0.01,
      creditsCharged: 5,
      status: 'ok',
    });
  });

  it('skips billing entirely when the computed credits round to zero', async () => {
    mocks.computeTtsUsd.mockReturnValue(0);
    mocks.usdToCredits.mockReturnValue(0);

    await deductTtsCredits(args);

    expect(mocks.subtractCredits).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('is non-fatal: a subtractCredits failure is logged, not thrown', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
    mocks.subtractCredits.mockRejectedValue(new Error('ledger down'));

    await expect(deductTtsCredits(args)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'TTS credit deduction failed - billing may be missed',
      expect.objectContaining({ userId: 'u1', credits: 5 })
    );
  });

  it('swallows a usage-event write failure without failing the deduction', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
    mocks.recordUsage.mockRejectedValue(new Error('analytics down'));

    await expect(deductTtsCredits(args)).resolves.toBeUndefined();
    expect(mocks.subtractCredits).toHaveBeenCalledTimes(1);
  });
});
