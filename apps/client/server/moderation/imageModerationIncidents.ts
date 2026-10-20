import { adminSettingsRepository, imageModerationIncidentRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { withReviewerAlerts } from './incidentReviewAlerts';

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
  incidents: { record: input => imageModerationIncidentRepository.record(input) },
  getRecipients: async () => {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    return getSettingsValue('ImageModerationReviewerEmails', settings, []);
  },
  sendEmail: async (to, email) => {
    const { default: mailer } = await import('@server/utils/mailer');
    return mailer.sendEmail(to, email);
  },
  appUrl: () => process.env.APP_URL,
  logger: {
    warn: (msg, meta) => Logger.globalInstance.warn(msg, meta),
    error: (msg, meta) => Logger.globalInstance.error(msg, meta),
  },
});
