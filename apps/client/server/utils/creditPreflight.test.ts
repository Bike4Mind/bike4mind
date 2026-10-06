import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findById: vi.fn(),
    getSettingsMap: vi.fn(),
    enforceCredits: vi.fn(),
  },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
  getSettingsValue: (key: string) => (key === 'enforceCredits' ? mocks.enforceCredits() : undefined),
}));

import { assertPreflightCredits, InsufficientCreditsPreflightError } from './creditPreflight';

const check = (estimatedCredits?: number) =>
  assertPreflightCredits({ userId: 'u1', estimatedCredits, featureLabel: 'text-to-speech' });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getSettingsMap.mockResolvedValue({});
  mocks.enforceCredits.mockReturnValue(true);
});

describe('assertPreflightCredits', () => {
  it.each([true, false])('rejects an unknown user whatever enforceCredits says (%s)', async enforced => {
    mocks.enforceCredits.mockReturnValue(enforced);
    mocks.findById.mockResolvedValue(null);
    await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
  });

  it.each([undefined, false])('admits a zero-balance user when enforceCredits is %s', async v => {
    mocks.enforceCredits.mockReturnValue(v);
    mocks.findById.mockResolvedValue({ currentCredits: 0 });
    await expect(check(100)).resolves.toBeUndefined();
  });

  describe('with credit enforcement on', () => {
    it.each([0, -5])('rejects a balance of %s even when the call is estimated free', async balance => {
      mocks.findById.mockResolvedValue({ currentCredits: balance });
      await expect(check(0)).rejects.toThrow('Insufficient credits for text-to-speech');
    });

    it('treats a missing currentCredits field as zero', async () => {
      mocks.findById.mockResolvedValue({});
      await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });

    it('admits any positive balance when no estimate is given', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 1 });
      await expect(check()).resolves.toBeUndefined();
    });

    it('rejects a positive balance that does not cover the estimate, naming both figures', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 3 });
      await expect(check(10)).rejects.toThrow(
        'You do not have enough credits for text-to-speech. You currently have 3 credits and this requires approximately 10.'
      );
    });

    it('admits a balance that exactly covers the estimate', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 10 });
      await expect(check(10)).resolves.toBeUndefined();
    });
  });
});
