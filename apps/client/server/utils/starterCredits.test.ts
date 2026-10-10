import { describe, it, expect, vi, beforeEach } from 'vitest';

const findBySettingNames = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingNames: (...args: unknown[]) => findBySettingNames(...args) },
}));

import { getOpenSignupStarterCredits } from './starterCredits';

const rows = (openReg: unknown, freeCredits: unknown) => [
  { settingName: 'allowOpenRegistration', settingValue: openReg },
  { settingName: 'defaultFreeCredits', settingValue: freeCredits },
];

describe('getOpenSignupStarterCredits', () => {
  beforeEach(() => {
    findBySettingNames.mockReset();
  });

  it('returns the default grant when open registration is on, in one query', async () => {
    findBySettingNames.mockResolvedValue(rows(true, 5000));

    await expect(getOpenSignupStarterCredits()).resolves.toBe(5000);
    expect(findBySettingNames).toHaveBeenCalledTimes(1);
  });

  it('returns 0 on an invite-only deployment', async () => {
    findBySettingNames.mockResolvedValue(rows(false, 5000));

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('returns 0 when neither setting is stored (open registration defaults off)', async () => {
    findBySettingNames.mockResolvedValue([]);

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });

  it('returns 0 when the lookup fails', async () => {
    findBySettingNames.mockRejectedValue(new Error('db down'));

    await expect(getOpenSignupStarterCredits()).resolves.toBe(0);
  });
});
