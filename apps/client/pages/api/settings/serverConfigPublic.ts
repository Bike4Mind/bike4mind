import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

export type ServerConfigPublic = {
  apiUrl: string;
  defaultTheme: string;
  /** When true, the registration form makes the invite code optional (self-serve signup). */
  allowOpenRegistration: boolean;
  /** Optional Pyodide mirror for offline Python artifacts; empty string uses the default CDN. */
  pyodideBaseUrl: string;
  /** When true, the MFA prompt offers "remember this device" so the next login skips TOTP. */
  allowTrustedDevices: boolean;
};

// Public pre-login config - minimal fields only.
// Sensitive fields (bucket names, WebSocket URL, PDF key, etc.) are served by
// /api/settings/serverConfig which requires authentication.
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req, res) => {
    // Surface only the registration master switch - never any sensitive setting - so the
    // pre-login register form knows whether an invite code is required. Parse through the
    // canonical Zod schema so persisted booleans, "true"/"false" strings, and missing records
    // all resolve correctly (raw `=== 'true'` would silently miss boolean-stored values).
    const setting = await adminSettingsRepository.findBySettingName('allowOpenRegistration').catch(() => null);
    const parsed = settingsMap.allowOpenRegistration.schema.safeParse(setting?.settingValue);
    let allowOpenRegistration = parsed.success ? parsed.data : false;

    // Self-host bootstrap: a fresh install (no users yet) accepts its first
    // registration without an invite, so report registration as open. This
    // mirrors the gate in the OTC verify route and flips back once a user exists.
    if (!allowOpenRegistration && process.env.B4M_SELF_HOST === 'true') {
      allowOpenRegistration = (await userRepository.count({})) === 0;
    }

    // Same treatment for the trusted-device switch, so the MFA prompt knows whether to
    // offer "remember this device". Defaults OPEN (unlike registration) to match the
    // setting's own default and the server-side `!== false` checks in the auth routes -
    // the checkbox is only ever a hint; /api/auth/mfa/verify re-checks before granting.
    const trustedSetting = await adminSettingsRepository.findBySettingName('allowTrustedDevices').catch(() => null);
    const trustedParsed = settingsMap.allowTrustedDevices.schema.safeParse(trustedSetting?.settingValue);
    const allowTrustedDevices = trustedParsed.success ? trustedParsed.data : true;

    const config: ServerConfigPublic = {
      // In dev, derive from request host so the URL matches the actual port
      apiUrl: process.env.APP_URL?.includes('localhost')
        ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:3000'}`
        : process.env.APP_URL || '',
      defaultTheme: 'bike4mind',
      allowOpenRegistration,
      pyodideBaseUrl: process.env.PYODIDE_BASE_URL || '',
      allowTrustedDevices,
    };

    return res.json(config);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
