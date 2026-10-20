import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deductCreditsWithOrgSupport: vi.fn(),
    recordUsage: vi.fn(),
    computeTtsUsd: vi.fn(),
    usdToCredits: vi.fn(),
    userFindById: vi.fn(),
    orgFindById: vi.fn(),
  },
}));

vi.mock('@bike4mind/common', () => ({
  CreditHolderType: { User: 'User', Organization: 'Organization' },
  computeTtsUsd: (...a: unknown[]) => mocks.computeTtsUsd(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  usdToCredits: (...a: unknown[]) => mocks.usdToCredits(...a),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { deductCreditsWithOrgSupport: (...a: unknown[]) => mocks.deductCreditsWithOrgSupport(...a) },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mocks.orgFindById(...a) },
  creditTransactionRepository: {},
  usageEventRepository: { record: (...a: unknown[]) => mocks.recordUsage(...a) },
}));

import { deductTtsCredits } from './deductTtsCredits';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.deductCreditsWithOrgSupport.mockResolvedValue(undefined);
  mocks.userFindById.mockResolvedValue({ id: 'u1' });
  mocks.orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 100 });
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
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);

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
      costUsd: 0.01,
      creditsCharged: 5,
      ownerId: 'u1',
      ownerType: 'User',
      status: 'ok',
    });
  });

  it('debits the selected organization pool and attributes the usage event to it', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
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
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
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
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
    mocks.userFindById.mockResolvedValue(null);

    await deductTtsCredits(args);

    expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('skips billing entirely when the computed credits round to zero', async () => {
    mocks.computeTtsUsd.mockReturnValue(0);
    mocks.usdToCredits.mockReturnValue(0);

    await deductTtsCredits(args);

    expect(mocks.deductCreditsWithOrgSupport).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('is non-fatal: a debit failure is logged, not thrown', async () => {
    mocks.computeTtsUsd.mockReturnValue(0.01);
    mocks.usdToCredits.mockReturnValue(5);
    mocks.deductCreditsWithOrgSupport.mockRejectedValue(new Error('ledger down'));

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
    expect(mocks.deductCreditsWithOrgSupport).toHaveBeenCalledTimes(1);
  });
});
