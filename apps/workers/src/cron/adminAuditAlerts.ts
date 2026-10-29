/**
 * Posts critical Admin Audit Log entries, and the first grant of each credit-grant burst, to the
 * security Slack webhook (AdminSettings SlackSecurityAlertsWebhookUrl; unset turns alerts off).
 * The logic and its retry contract live in adminAuditService.dispatchAdminAuditAlerts.
 * Schedule: rate(1 minute) on prod and dev (infra/cron.ts adminAuditAlerts).
 * Self-host equivalent: apps/workers/src/selfhost/adminAuditAlerts.ts.
 */
import { toAbsoluteUrl } from '@bike4mind/common';
import {
  adminAuditAlertStateRepository,
  adminAuditLogRepository,
  adminSettingsRepository,
  connectDB,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { adminAuditService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { getSettingsMap, getSettingsValue, postMessageToSlack } from '@bike4mind/utils';
import { Resource } from 'sst';
import type { Request } from 'express';
import { reconcileExpiredImpersonations } from '@server/auth/impersonation';

const logger = new Logger({ metadata: { service: 'adminAuditAlerts' } });

export async function runAdminAuditAlerts(): Promise<adminAuditService.AdminAuditAlertRunResult> {
  await reconcileExpiredImpersonations({ headers: {}, url: '/workers/support-access-expiry', logger } as Request);
  // Fresh read every run so clearing the webhook stops alerts on the next minute, not after a cache TTL.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['SlackSecurityAlertsWebhookUrl'] }
  );
  const appUrl = process.env.APP_URL?.trim();

  const result = await adminAuditService.dispatchAdminAuditAlerts({
    db: { adminAuditLog: adminAuditLogRepository, alertState: adminAuditAlertStateRepository },
    webhookUrl: getSettingsValue('SlackSecurityAlertsWebhookUrl', settings, '').trim(),
    postMessage: postMessageToSlack,
    toAppUrl: path => (appUrl ? toAbsoluteUrl(appUrl, path) : null),
    logger,
  });
  if (result.status === 'ran' && result.scanned > 0) logger.info('[adminAuditAlerts] done', result);
  return result;
}

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runAdminAuditAlerts();
};
