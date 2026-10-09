import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findById: vi.fn(),
    getSettingsMap: vi.fn(),
  },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
}));
// Keep the real getSettingsValue: the hosted default (enforcement on when the
// setting is unset) is the behaviour these tests exist to pin.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

import { assertPreflightCredits, InsufficientCreditsPreflightError } from './creditPreflight';

const check = (estimatedCredits?: number) =>
  assertPreflightCredits({ userId: 'u1', estimatedCredits, featureLabel: 'text-to-speech' });

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getSettingsMap.mockResolvedValue({});
});

describe('assertPreflightCredits', () => {
  describe('enforcement on (the hosted default when the setting is unset)', () => {
    it('rejects a user that does not exist', async () => {
      mocks.findById.mockResolvedValue(null);
      await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });

    it('rejects a zero balance even when the call is estimated free', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 0 });
      await expect(check(0)).rejects.toThrow('Insufficient credits for text-to-speech');
    });

    it('rejects a negative balance', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: -5 });
      await expect(check(0)).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
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

  describe('enforcement off (an explicit false setting)', () => {
    beforeEach(() => mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' }));

    it('admits a zero-balance user', async () => {
      mocks.findById.mockResolvedValue({ currentCredits: 0 });
      await expect(check(100)).resolves.toBeUndefined();
    });

    it('still rejects a user that does not exist', async () => {
      mocks.findById.mockResolvedValue(null);
      await expect(check()).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
    });
  });

  describe('read failures', () => {
    it('propagates a settings read failure rather than admitting', async () => {
      const boom = new Error('settings down');
      mocks.getSettingsMap.mockRejectedValue(boom);
      mocks.findById.mockResolvedValue({ currentCredits: 100 });
      await expect(check()).rejects.toBe(boom);
    });

    it('propagates a user read failure rather than admitting', async () => {
      const boom = new Error('db down');
      mocks.findById.mockRejectedValue(boom);
      await expect(check()).rejects.toBe(boom);
    });
  });
});
