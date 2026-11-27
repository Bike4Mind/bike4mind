import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindSetting = vi.fn();
const mockCount = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: (...a: unknown[]) => mockFindSetting(...a) },
  userRepository: { count: (...a: unknown[]) => mockCount(...a) },
}));

import { isOpenRegistrationAllowed } from './openRegistration';

describe('isOpenRegistrationAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSetting.mockResolvedValue(null);
    mockCount.mockResolvedValue(0);
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('opens a fresh self-host install when no bootstrap email is configured', async () => {
    expect(await isOpenRegistrationAllowed()).toBe(true);
  });

  it('stays closed on a fresh self-host install when a bootstrap email is configured', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', 'owner@example.com');

    expect(await isOpenRegistrationAllowed()).toBe(false);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('stays closed once a user exists', async () => {
    mockCount.mockResolvedValue(1);

    expect(await isOpenRegistrationAllowed()).toBe(false);
  });

  it('honors an explicit open-registration setting even with a bootstrap email', async () => {
    vi.stubEnv('B4M_BOOTSTRAP_ADMIN_EMAIL', 'owner@example.com');
    mockFindSetting.mockResolvedValue({ settingValue: true });

    expect(await isOpenRegistrationAllowed()).toBe(true);
  });

  it('returns the stored value outside self-host', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');

    expect(await isOpenRegistrationAllowed()).toBe(false);
    expect(mockCount).not.toHaveBeenCalled();

    mockFindSetting.mockResolvedValue({ settingValue: true });
    expect(await isOpenRegistrationAllowed()).toBe(true);
  });
});
