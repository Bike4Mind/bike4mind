import { adminSettingsRepository, imageModerationIncidentRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap } from '@bike4mind/utils';
import {
  withReviewerAlerts,
  type IncidentReviewDelivery,
} from '@bike4mind/server-utils/moderation/incidentReviewAlerts';

/**
 * Origin for the admin link. APP_URL is set only on the web Lambda, so the queue, chat, agent and
 * upload-scan Lambdas that also record incidents fall back to SERVER_DOMAIN (DEFAULT_LAMBDA_ENVIRONMENT),
 * which serves the app at app.<SERVER_DOMAIN> (infra/router.ts). Undefined leaves a relative link.
 */
export function resolveAdminAppUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const appUrl = env.APP_URL?.trim();
  if (appUrl) return appUrl;
  const domain = env.SERVER_DOMAIN?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return domain ? `https://app.${domain}` : undefined;
}

// Loaded once, on the first alert.
let mailerModule: Promise<typeof import('@server/utils/mailer')> | undefined;

/**
 * Recipients, mail transport, admin link and logger shared by the request-path alert and the
 * scheduled review sweep (apps/workers/src/cron/imageModerationReviewSweep.ts), so both read the
 * same ImageModerationReviewerEmails setting and render the same alert.
 *
 * Mail goes straight through the SMTP mailer rather than the email.send event: the upload scan
 * Lambda records incidents too and is not linked to the event bus.
 */
export function createReviewerAlertDelivery(options: { skipSettingsCache?: boolean } = {}): IncidentReviewDelivery {
  // Every dependency resolves at call time, so importing this module costs an image path nothing.
  return {
    getRecipients: async () => {
      const stores = { adminSettings: adminSettingsRepository };
      const settings = await (options.skipSettingsCache
        ? getSettingsMap(stores, { skipCache: true })
        : getSettingsMap(stores));
      const raw = settings.ImageModerationReviewerEmails;
      if (typeof raw !== 'string') return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    },
    sendEmail: async (to, email) => {
      const { default: mailer } = await (mailerModule ??= import('@server/utils/mailer'));
      return mailer.sendEmail(to, email, { mirror: false, logRecipient: false });
    },
    appUrl: () => resolveAdminAppUrl(),
    logger: {
      warn: (msg, meta) => Logger.globalInstance.warn(msg, meta),
      error: (msg, meta) => Logger.globalInstance.error(msg, meta),
    },
  };
}

/**
 * The incident store every image moderation gate records through (generation, edit, avatar and
 * upload paths, in apps/client and apps/workers). Wire this, not the bare repository, so a new
 * incident always alerts the reviewers configured in ImageModerationReviewerEmails.
 */
export const imageModerationIncidents = withReviewerAlerts({
  ...createReviewerAlertDelivery(),
  incidents: {
    record: input => imageModerationIncidentRepository.record(input),
    markAlerted: id => imageModerationIncidentRepository.markAlerted(id),
  },
});
