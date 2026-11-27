import { settingsMap, type ClientConfigPublic } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { isOpenRegistrationAllowed } from '@server/utils/auth/openRegistration';
import { getTurnstilePolicy } from '@server/utils/auth/turnstile';
import { getAppleConfig } from '@bike4mind/server-utils/auth/appleConfig';
import { publicAppUrl } from '@bike4mind/server-utils/utils/validators';
import { configuredSupportEmail } from '@server/auth/blockedSignIn';

export async function resolvePublicClientConfig(req: Parameters<typeof publicAppUrl>[0]): Promise<ClientConfigPublic> {
  const allowOpenRegistration = await isOpenRegistrationAllowed();
  const trustedSetting = await adminSettingsRepository.findBySettingName('allowTrustedDevices').catch(() => null);
  const trustedParsed = settingsMap.allowTrustedDevices.schema.safeParse(trustedSetting?.settingValue);
  const turnstile = await getTurnstilePolicy();
  return {
    api_url: publicAppUrl(req),
    default_theme: 'bike4mind',
    allow_open_registration: allowOpenRegistration,
    pyodide_base_url: process.env.PYODIDE_BASE_URL || '',
    allow_trusted_devices: trustedParsed.success ? trustedParsed.data : true,
    turnstile_site_key: turnstile.active ? turnstile.siteKey : '',
    apple_sign_in_enabled: getAppleConfig() !== null,
    support_email: configuredSupportEmail() ?? '',
  };
}
