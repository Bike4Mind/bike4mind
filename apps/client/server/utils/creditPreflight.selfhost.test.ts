import { describe, it, expect, vi, beforeEach } from 'vitest';

// Self-host computes the enforceCredits default (off) when the settings module
// first loads, so pin the environment in its own file before any import - the
// mocked settings module cannot be re-evaluated in-process.
const { mocks } = vi.hoisted(() => {
  process.env.B4M_SELF_HOST = 'true';
  return {
    mocks: {
      findById: vi.fn(),
      getSettingsMap: vi.fn(),
    },
  };
});

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

import { assertPreflightCredits, InsufficientCreditsPreflightError } from './creditPreflight';

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getSettingsMap.mockResolvedValue({});
});

describe('assertPreflightCredits under self-host', () => {
  it('admits a zero-balance user when the setting is unset (enforcement defaults off)', async () => {
    mocks.findById.mockResolvedValue({ currentCredits: 0 });
    await expect(
      assertPreflightCredits({ userId: 'u1', estimatedCredits: 100, featureLabel: 'text-to-speech' })
    ).resolves.toBeUndefined();
  });

  it('still rejects a zero-balance user when the setting is explicitly on', async () => {
    mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'true' });
    mocks.findById.mockResolvedValue({ currentCredits: 0 });
    await expect(
      assertPreflightCredits({ userId: 'u1', estimatedCredits: 100, featureLabel: 'text-to-speech' })
    ).rejects.toBeInstanceOf(InsufficientCreditsPreflightError);
  });
});
