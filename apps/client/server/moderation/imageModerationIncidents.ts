import { adminSettingsRepository, imageModerationIncidentRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap } from '@bike4mind/utils';
import { withReviewerAlerts } from './incidentReviewAlerts';

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

/**
 * The incident store every image moderation gate records through (generation, edit, avatar and
 * upload paths, in apps/client and apps/workers). Wire this, not the bare repository, so a new
 * incident always alerts the reviewers configured in ImageModerationReviewerEmails.
 *
 * Mail goes straight through the SMTP mailer rather than the email.send event: the upload scan
 * Lambda records incidents too and is not linked to the event bus.
 */
export const imageModerationIncidents = withReviewerAlerts({
  // Every dependency resolves at call time, so importing this module costs an image path nothing.
  incidents: {
    record: input => imageModerationIncidentRepository.record(input),
    markAlerted: id => imageModerationIncidentRepository.markAlerted(id),
  },
  getRecipients: async () => {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const raw = settings.ImageModerationReviewerEmails;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },
  sendEmail: async (to, email) => {
    const { default: mailer } = await import('@server/utils/mailer');
    return mailer.sendEmail(to, email, { mirror: false, logRecipient: false });
  },
  appUrl: () => resolveAdminAppUrl(),
  logger: {
    warn: (msg, meta) => Logger.globalInstance.warn(msg, meta),
    error: (msg, meta) => Logger.globalInstance.error(msg, meta),
  },
});
