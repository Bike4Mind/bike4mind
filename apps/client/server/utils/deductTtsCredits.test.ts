import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deductCreditsWithOrgSupport: vi.fn(),
    recordUsage: vi.fn(),
    computeTtsUsd: vi.fn(),
    settlementDraw: vi.fn(),
    userFindById: vi.fn(),
    orgFindById: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', async importActual => ({
  CreditHolderType: { User: 'User', Organization: 'Organization' },
  CREDITS_PER_USD_COST: (await importActual<typeof import('@bike4mind/common')>()).CREDITS_PER_USD_COST,
  computeTtsUsd: (...a: unknown[]) => mocks.computeTtsUsd(...a),
}));
// The real stochastic rounding, with its draw pinned so the debit is assertable.
vi.mock('@bike4mind/utils', async () => {
  const { usdToCreditsStochastic } = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return { usdToCreditsStochastic: (usd: number) => usdToCreditsStochastic(usd, () => mocks.settlementDraw()) };
});
vi.mock('@bike4mind/services', () => ({
  creditService: { deductCreditsWithOrgSupport: (...a: unknown[]) => mocks.deductCreditsWithOrgSupport(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mocks.orgFindById(...a) },
  creditTransactionRepository: {},
  usageEventRepository: { record: (...a: unknown[]) => mocks.recordUsage(...a) },
}));

import { CREDITS_PER_USD_COST } from '@bike4mind/common';
import { deductTtsCredits } from './deductTtsCredits';

const usdForCredits = (credits: number) => credits / CREDITS_PER_USD_COST;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.deductCreditsWithOrgSupport.mockResolvedValue(undefined);
  mocks.userFindById.mockResolvedValue({ id: 'u1' });
  mocks.orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 100 });
  mocks.settlementDraw.mockReturnValue(0.75);
});

describe('deductTtsCredits', () => {
  const args = {
    userId: 'u1',
    vendor: 'elevenlabs' as const,
    model: 'eleven_multilingual_v2',
    characters: 100,
    logger,
  };

  it('charges the computed credits to the user and records a usage event on success', async () => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));

    await deductTtsCredits(args);

    expect(mocks.computeTtsUsd).toHaveBeenCalledWith('elevenlabs', 'eleven_multilingual_v2', 100);
    expect(mocks.deductCreditsWithOrgSupport).toHaveBeenCalledTimes(1);
    const [params] = mocks.deductCreditsWithOrgSupport.mock.calls[0];
    expect(params).toMatchObject({
      type: 'text_to_speech_usage',
      user: { id: 'u1' },
      organization: null,
      credits: 5,
      model: 'eleven_multilingual_v2',
    });
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      feature: 'text_to_speech',
      provider: 'elevenlabs',
      units: 100,
      costUsd: usdForCredits(5.5),
      creditsCharged: 5,
      ownerId: 'u1',
      ownerType: 'User',
      status: 'ok',
    });
  });

  it('debits the selected organization pool and attributes the usage event to it', async () => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));
    const organization = { id: 'org1', currentCredits: 100, userDetails: [], users: [{ userId: 'u1' }] };
    mocks.orgFindById.mockResolvedValue(organization);

    await deductTtsCredits({ ...args, billingOrganizationId: 'org1' });

    const [params] = mocks.deductCreditsWithOrgSupport.mock.calls[0];
    expect(params).toMatchObject({ user: { id: 'u1' }, organization, credits: 5 });
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      userId: 'u1',
      ownerId: 'org1',
      ownerType: 'Organization',
      creditsCharged: 5,
    });
  });

  it('skips billing when the named organization no longer exists', async () => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));
    mocks.orgFindById.mockResolvedValue(null);

    await deductTtsCredits({ ...args, billingOrganizationId: 'gone' });

    expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'TTS credit deduction failed - billing may be missed',
      expect.objectContaining({ userId: 'u1', credits: 5 })
    );
  });

  it('skips billing when the user no longer exists', async () => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));
    mocks.userFindById.mockResolvedValue(null);

    await deductTtsCredits(args);

    expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    [0.25, 6],
    [0.75, 5],
  ])('debits N or N+1 for a cost of N + 0.5 credits (draw %s -> %s)', async (draw, expected) => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));
    mocks.settlementDraw.mockReturnValue(draw);

    await deductTtsCredits(args);

    expect(mocks.deductCreditsWithOrgSupport.mock.calls[0][0]).toMatchObject({ credits: expected });
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({ creditsCharged: expected });
  });

  it('can debit 0 for a tiny cost: no ledger write, but the usage event still records the call', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.00001);
    mocks.settlementDraw.mockReturnValue(0.5);

    await deductTtsCredits(args);

    expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsage.mock.calls[0][0]).toMatchObject({
      feature: 'text_to_speech',
      costUsd: 0.00001,
      creditsCharged: 0,
      ownerId: 'u1',
    });
  });

  it('skips billing and the usage event when the synthesis has no cost', async () => {
    mocks.computeTtsUsd.mockReturnValue(0);

    await deductTtsCredits(args);

    expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('is non-fatal: a debit failure is logged, not thrown', async () => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));
    mocks.deductCreditsWithOrgSupport.mockRejectedValue(new Error('ledger down'));

    await expect(deductTtsCredits(args)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'TTS credit deduction failed - billing may be missed',
      expect.objectContaining({ userId: 'u1', credits: 5 })
    );
  });

  it('swallows a usage-event write failure without failing the deduction', async () => {
    mocks.computeTtsUsd.mockReturnValue(usdForCredits(5.5));
    mocks.recordUsage.mockRejectedValue(new Error('analytics down'));

    await expect(deductTtsCredits(args)).resolves.toBeUndefined();
    expect(mocks.deductCreditsWithOrgSupport).toHaveBeenCalledTimes(1);
  });
});
