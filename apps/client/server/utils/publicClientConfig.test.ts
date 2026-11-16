import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConfigPublicSchema } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findBySettingName: vi.fn(),
  isOpenRegistrationAllowed: vi.fn(),
  getTurnstilePolicy: vi.fn(),
  getAppleConfig: vi.fn(),
  configuredSupportEmail: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: mocks }));
vi.mock('@server/utils/auth/openRegistration', () => mocks);
vi.mock('@server/utils/auth/turnstile', () => mocks);
vi.mock('@bike4mind/server-utils/auth/appleConfig', () => mocks);
vi.mock('@server/auth/blockedSignIn', () => mocks);
vi.mock('@bike4mind/server-utils/utils/validators', () => ({ publicAppUrl: () => 'https://example.com' }));

import { resolvePublicClientConfig } from './publicClientConfig';

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mocks.findBySettingName.mockResolvedValue(null);
  mocks.isOpenRegistrationAllowed.mockResolvedValue(false);
  mocks.getTurnstilePolicy.mockResolvedValue({ active: false, siteKey: 'inactive-key' });
  mocks.getAppleConfig.mockReturnValue(null);
});

describe('resolvePublicClientConfig', () => {
  it('preserves empty values and trusted-device defaults without publishing private configuration', async () => {
    vi.stubEnv('PYODIDE_BASE_URL', '');
    vi.stubEnv('CHAT_COMPLETION_PUBLIC_URL', 'PRIVATE-MARKER');
    const config = await resolvePublicClientConfig({ headers: {} });
    expect(config).toEqual({
      api_url: 'https://example.com',
      default_theme: 'bike4mind',
      allow_open_registration: false,
      pyodide_base_url: '',
      allow_trusted_devices: true,
      turnstile_site_key: '',
      apple_sign_in_enabled: false,
      support_email: '',
    });
    expect(ClientConfigPublicSchema.strict().safeParse(config).success).toBe(true);
    expect(JSON.stringify(config)).not.toContain('PRIVATE-MARKER');
    expect(mocks.findBySettingName).toHaveBeenCalledExactlyOnceWith('allowTrustedDevices');
  });

  it('preserves configured false flags and active challenge values', async () => {
    mocks.findBySettingName.mockResolvedValue({ settingValue: 'false' });
    mocks.isOpenRegistrationAllowed.mockResolvedValue(true);
    mocks.getTurnstilePolicy.mockResolvedValue({ active: true, siteKey: 'public-site-key' });
    mocks.getAppleConfig.mockReturnValue({ secret: 'PRIVATE-MARKER' });
    mocks.configuredSupportEmail.mockReturnValue('support@example.com');
    vi.stubEnv('PYODIDE_BASE_URL', 'https://example.com/python');
    const config = await resolvePublicClientConfig({ headers: {} });
    expect(config).toMatchObject({
      allow_open_registration: true,
      allow_trusted_devices: false,
      apple_sign_in_enabled: true,
      turnstile_site_key: 'public-site-key',
      support_email: 'support@example.com',
      pyodide_base_url: 'https://example.com/python',
    });
    expect(JSON.stringify(config)).not.toContain('PRIVATE-MARKER');
  });

  it.each(['invalid', undefined])('defaults malformed trusted-device rows (%s) to enabled', async settingValue => {
    mocks.findBySettingName.mockResolvedValue({ settingValue });
    expect((await resolvePublicClientConfig({ headers: {} })).allow_trusted_devices).toBe(true);
  });

  it('retains the trusted-device default on a lookup failure', async () => {
    mocks.findBySettingName.mockRejectedValue(new Error('unavailable'));
    expect((await resolvePublicClientConfig({ headers: {} })).allow_trusted_devices).toBe(true);
  });
});
