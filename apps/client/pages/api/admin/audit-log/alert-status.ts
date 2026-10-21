import {
  ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS,
  ADMIN_AUDIT_DEFAULT_DAILY_GRANT_CREDITS,
  ApiKeyScope,
  type AuditAlertStatus,
} from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';

// The webhook itself is sensitive, so only whether it is set leaves the server.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    {
      skipCache: true,
      names: ['SlackSecurityAlertsWebhookUrl', 'AdminAuditCriticalGrantCredits', 'AdminAuditDailyGrantCredits'],
    }
  );
  const status: AuditAlertStatus = {
    alertsEnabled: getSettingsValue('SlackSecurityAlertsWebhookUrl', settings, '').trim() !== '',
    singleGrantCredits: getSettingsValue(
      'AdminAuditCriticalGrantCredits',
      settings,
      ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS
    ),
    dailyGrantCredits: getSettingsValue(
      'AdminAuditDailyGrantCredits',
      settings,
      ADMIN_AUDIT_DEFAULT_DAILY_GRANT_CREDITS
    ),
  };
  return res.json(status);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
