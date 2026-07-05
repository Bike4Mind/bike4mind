import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

export type ServerConfigPublic = {
  apiUrl: string;
  defaultTheme: string;
  /** When true, the registration form makes the invite code optional (self-serve signup). */
  allowOpenRegistration: boolean;
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
    const allowOpenRegistration = parsed.success ? parsed.data : false;

    const config: ServerConfigPublic = {
      // In dev, derive from request host so the URL matches the actual port
      apiUrl: process.env.APP_URL?.includes('localhost')
        ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:3000'}`
        : process.env.APP_URL || '',
      defaultTheme: 'groktool',
      allowOpenRegistration,
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
