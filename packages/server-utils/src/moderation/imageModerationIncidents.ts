import { partitionEmailList } from '@bike4mind/common';
import { adminSettingsRepository, imageModerationIncidentRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap } from '@bike4mind/utils';
import {
  alertEscalationReviewers,
  withReviewerAlerts,
  type IncidentAlertOutcome,
  type IncidentEscalationDelivery,
  type RecordedIncident,
} from './incidentReviewAlerts';

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
let mailerModule: Promise<typeof import('../utils/mailer/queuedMailer')> | undefined;

type ReviewerListSetting = 'ImageModerationReviewerEmails' | 'ImageModerationEscalationEmails';

// Stored as a JSON string; anything that does not parse holds no address.
const parseStoredEmailList = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
};

/**
 * Recipients, mail transport, admin link and logger shared by the request-path alert, the escalate
 * route and the scheduled review sweep (apps/workers/src/cron/imageModerationReviewSweep.ts), so all
 * of them read the same ImageModerationReviewerEmails and ImageModerationEscalationEmails settings
 * and render the same emails.
 *
 * Mail is queued for the email-send worker, so every function that records an incident has to be
 * linked to the event bus (infra/__tests__/mailSenderBusLinks.test.ts). An alert that cannot be
 * queued leaves the incident unstamped for the review sweep to pick up. A queued alert stamps only
 * alertQueuedAt; the email-send worker stamps alertedAt once a reviewer's copy is delivered
 * (recordEmailDeliveryOutcome), and the sweep resends one left unconfirmed past its in-flight window.
 */
export function createReviewerAlertDelivery(options: { skipSettingsCache?: boolean } = {}): IncidentEscalationDelivery {
  const readEmailList = async (name: ReviewerListSetting) => {
    const stores = { adminSettings: adminSettingsRepository };
    const settings = await (options.skipSettingsCache
      ? getSettingsMap(stores, { skipCache: true })
      : getSettingsMap(stores));
    return parseStoredEmailList(settings[name]);
  };
  // Every dependency resolves at call time, so importing this module costs an image path nothing.
  return {
    getRecipients: () => readEmailList('ImageModerationReviewerEmails'),
    getEscalationRecipients: () => readEmailList('ImageModerationEscalationEmails'),
    sendEmail: async (to, email, ref) => {
      const { queuedMailer } = await (mailerModule ??= import('../utils/mailer/queuedMailer'));
      return queuedMailer.sendEmail(to, email, { mirror: false, logRecipient: false, ...(ref && { ref }) });
    },
    appUrl: () => resolveAdminAppUrl(),
    logger: {
      warn: (msg, meta) => Logger.globalInstance.warn(msg, meta),
      error: (msg, meta) => Logger.globalInstance.error(msg, meta),
    },
  };
}

/**
 * Whether each reviewer list holds at least one address the alerts would send to (the same
 * partitionEmailList rule). Read past the settings cache so a list saved moments ago shows at once.
 * Returns no address and no count of addresses.
 */
export async function getReviewerListStatus(): Promise<{
  reviewersConfigured: boolean;
  escalationReviewersConfigured: boolean;
}> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['ImageModerationReviewerEmails', 'ImageModerationEscalationEmails'] }
  );
  const configured = (name: ReviewerListSetting) =>
    partitionEmailList(parseStoredEmailList(settings[name])).valid.length > 0;
  return {
    reviewersConfigured: configured('ImageModerationReviewerEmails'),
    escalationReviewersConfigured: configured('ImageModerationEscalationEmails'),
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
    markAlertQueued: id => imageModerationIncidentRepository.markAlertQueued(id),
  },
});

/**
 * Emails the escalation list about an incident a reviewer just escalated and stamps
 * escalationAlertedAt (inline delivery) or escalationAlertQueuedAt (queued). Never throws; the review
 * sweep retries a send that was not delivered.
 */
export function sendIncidentEscalationAlert(
  incident: RecordedIncident
): Promise<{ outcome: IncidentAlertOutcome; alertedAt: Date | null; queuedAt: Date | null }> {
  return alertEscalationReviewers(incident, {
    // An admin who has just saved the escalation list should not escalate into a stale cached copy.
    ...createReviewerAlertDelivery({ skipSettingsCache: true }),
    incidents: {
      markEscalationAlerted: (id, at) => imageModerationIncidentRepository.markEscalationAlerted(id, at),
      markEscalationAlertQueued: (id, at) => imageModerationIncidentRepository.markEscalationAlertQueued(id, at),
    },
  });
}
