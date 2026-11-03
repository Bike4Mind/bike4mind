import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isOpenRegistrationAllowed } from '@server/utils/auth/openRegistration';
import { getTurnstilePolicy } from '@server/utils/auth/turnstile';
import { publicAppUrl } from '@server/utils/validators';

export type ServerConfigPublic = {
  apiUrl: string;
  defaultTheme: string;
  /** When true, the registration form makes the invite code optional (self-serve signup). */
  allowOpenRegistration: boolean;
  /** Optional Pyodide mirror for offline Python artifacts; empty string uses the default CDN. */
  pyodideBaseUrl: string;
  /** When true, the MFA prompt offers "remember this device" so the next login skips TOTP. */
  allowTrustedDevices: boolean;
  /** Turnstile site key; empty when the challenge is not enforced on this stage. */
  turnstileSiteKey: string;
};

// Public pre-login config - minimal fields only.
// Sensitive fields (bucket names, WebSocket URL, PDF key, etc.) are served by
// /api/settings/serverConfig which requires authentication.
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req, res) => {
    // Surface only the registration master switch - never any sensitive setting - so the
    // pre-login register form knows whether an invite code is required. Shared with the
    // server-side gates that enforce it (see isOpenRegistrationAllowed) so what the form
    // shows and what the server accepts can never diverge.
    const allowOpenRegistration = await isOpenRegistrationAllowed();

    // Same treatment for the trusted-device switch, so the MFA prompt knows whether to
    // offer "remember this device". Defaults OPEN (unlike registration) to match the
    // setting's own default and the server-side `!== false` checks in the auth routes -
    // the checkbox is only ever a hint; /api/auth/mfa/verify re-checks before granting.
    const trustedSetting = await adminSettingsRepository.findBySettingName('allowTrustedDevices').catch(() => null);
    const trustedParsed = settingsMap.allowTrustedDevices.schema.safeParse(trustedSetting?.settingValue);
    const allowTrustedDevices = trustedParsed.success ? trustedParsed.data : true;

    const turnstile = await getTurnstilePolicy();

    const config: ServerConfigPublic = {
      apiUrl: publicAppUrl(req),
      defaultTheme: 'bike4mind',
      allowOpenRegistration,
      pyodideBaseUrl: process.env.PYODIDE_BASE_URL || '',
      allowTrustedDevices,
      turnstileSiteKey: turnstile.active ? turnstile.siteKey : '',
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
