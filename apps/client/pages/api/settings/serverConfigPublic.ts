import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { resolvePublicClientConfig } from '@server/utils/publicClientConfig';

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
  /** True when Apple credentials are configured, so the login page offers Sign in with Apple. */
  appleSignInEnabled: boolean;
  /** Support address the login page names on a blocked-account notice; empty when not configured. */
  supportEmail: string;
};

// Public pre-login config - minimal fields only.
// Sensitive fields (bucket names, WebSocket URL, PDF key, etc.) are served by
// /api/settings/serverConfig which requires authentication.
const handler = baseApi({ auth: false }).get(
  asyncHandler(async (req, res) => {
    const resolved = await resolvePublicClientConfig(req);
    const config: ServerConfigPublic = {
      apiUrl: resolved.api_url,
      defaultTheme: resolved.default_theme,
      allowOpenRegistration: resolved.allow_open_registration,
      pyodideBaseUrl: resolved.pyodide_base_url,
      allowTrustedDevices: resolved.allow_trusted_devices,
      turnstileSiteKey: resolved.turnstile_site_key,
      appleSignInEnabled: resolved.apple_sign_in_enabled,
      supportEmail: resolved.support_email,
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
