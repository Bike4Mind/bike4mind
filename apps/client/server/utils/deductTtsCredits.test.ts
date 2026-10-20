import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    settle: vi.fn(),
    recordUsage: vi.fn(),
    computeTtsUsd: vi.fn(),
    usdToCredits: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', () => ({
  CreditHolderType: { User: 'User', Organization: 'Organization' },
  computeTtsUsd: (...a: unknown[]) => mocks.computeTtsUsd(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  usdToCredits: (...a: unknown[]) => mocks.usdToCredits(...a),
}));
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { record: (...a: unknown[]) => mocks.recordUsage(...a) },
}));

import { deductTtsCredits } from './deductTtsCredits';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const hold = (overrides: Record<string, unknown> = {}) =>
  ({
    ownerId: 'u1',
    ownerType: 'User',
    settle: (...a: unknown[]) => mocks.settle(...a),
    release: vi.fn(),
    ...overrides,
  }) as never;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.settle.mockImplementation(async (credits: number) => credits);
});

describe('deductTtsCredits', () => {
  const args = {
    hold: hold(),
    userId: 'u1',
    vendor: 'elevenlabs' as const,
    model: 'eleven_multilingual_v2',
    characters: 100,
    logger,
  };

  it('settles the computed credits against the hold and records a usage event on success', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);

    await deductTtsCredits(args);

    expect(mocks.computeTtsUsd).toHaveBeenCalledWith('elevenlabs', 'eleven_multilingual_v2', 100);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.settle).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ type: 'text_to_speech_usage', model: 'eleven_multilingual_v2' })
    );
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      feature: 'text_to_speech',
      provider: 'elevenlabs',
      units: 100,
      costUsd: 0.01,
      creditsCharged: 5,
      ownerId: 'u1',
      ownerType: 'User',
      status: 'ok',
    });
  });

  it('records the settled charge returned by the hold', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.05);
    mocks.usdToCredits.mockReturnValue(25);
    mocks.settle.mockResolvedValue(5);

    await deductTtsCredits(args);

    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({ creditsCharged: 5 });
  });

  it('attributes the usage event to the organization the hold billed', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);

    await deductTtsCredits({ ...args, hold: hold({ ownerId: 'org1', ownerType: 'Organization' }) });

    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      userId: 'u1',
      ownerId: 'org1',
      ownerType: 'Organization',
      creditsCharged: 5,
    });
  });

  it('records no usage event when nothing was charged', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
    mocks.settle.mockResolvedValue(0);

    await deductTtsCredits(args);

    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('settles at zero - refunding the whole hold - when the cost rounds to no credits', async () => {
    mocks.computeTtsUsd.mockReturnValue(0);
    mocks.usdToCredits.mockReturnValue(0);

    await deductTtsCredits(args);

    expect(mocks.settle).toHaveBeenCalledWith(0, expect.objectContaining({ type: 'text_to_speech_usage' }));
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('swallows a usage-event write failure without failing the deduction', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
    mocks.recordUsage.mockRejectedValue(new Error('analytics down'));

    await expect(deductTtsCredits(args)).resolves.toBeUndefined();
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });
});
