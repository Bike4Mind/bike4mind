import {
  adminModerationIncidentPath,
  partitionEmailList,
  toAbsoluteUrl,
  type ImageModerationIncident,
  type IncidentSurface,
} from '@bike4mind/common';
import { escapeHtml } from '../utils/mailer/emailHelpers';

/** The fields of a stored incident the alert reads; anything else on the record is never rendered. */
export interface RecordedIncident {
  id: string;
  createdAt: Date | string;
  surface?: IncidentSurface;
  reviewStatus?: ImageModerationIncident['reviewStatus'];
}

export interface IncidentReviewAlertDeps {
  incidents: {
    record(input: ImageModerationIncident): Promise<RecordedIncident>;
    markAlerted(id: string): Promise<void>;
  };
  /** The stored ImageModerationReviewerEmails value; entries are validated one at a time here. */
  getRecipients: () => Promise<unknown>;
  /** Mirrors MailService.sendEmail for a single recipient, resolving false when delivery failed. */
  sendEmail: (to: string, email: { subject: string; html: string }) => Promise<false | object>;
  appUrl: () => string | undefined;
  logger: { warn(msg: string, meta: unknown): void; error(msg: string, meta: unknown): void };
}

// Recording sits on the image request path, and the SMTP transport's own timeouts add up to tens
// of seconds, so the alert gets a short budget. A send that misses it is best-effort (it may still
// land, unstamped) until the send moves onto the email event with its retries.
export const REVIEW_ALERT_TIMEOUT_MS = 5_000;

/**
 * Renders the reviewer alert from an allowlist of incident metadata. It must never carry the image,
 * a stored-file key or URL, the prompt, the detection labels, or anything identifying the user: a
 * mailbox is not an access-controlled review surface, so the reviewer reads the detail in admin.
 */
export function renderIncidentReviewAlert(
  incident: RecordedIncident,
  reviewUrl: string
): { subject: string; html: string } {
  const rows: [string, string][] = [
    ['Incident id', incident.id],
    ['Created', new Date(incident.createdAt).toISOString()],
    ['Surface', incident.surface ?? 'unknown'],
  ];
  const table = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`).join('');
  return {
    subject: 'Moderation review pending',
    html:
      `<p>A moderation incident is waiting in the admin console.</p><table>${table}</table>` +
      `<p><a href="${escapeHtml(reviewUrl)}">${escapeHtml(reviewUrl)}</a></p>`,
  };
}

const needsReview = (incident: RecordedIncident) =>
  !incident.reviewStatus || incident.reviewStatus === 'pending_review';

/** The deps the alert needs to render and send, without the incident store. */
export type IncidentReviewDelivery = Omit<IncidentReviewAlertDeps, 'incidents'>;

export type IncidentAlertOutcome = 'delivered' | 'no_recipients' | 'failed';

// Digest links land on the admin console base path.
// TODO: link the moderation review tab directly once it is merged (see adminModerationIncidentPath).
const ADMIN_CONSOLE_PATH = '/admin';

export interface IncidentReminderDigest {
  /** Incidents still awaiting a verdict. */
  pendingCount: number;
  /** Age of the oldest of them, in minutes. */
  oldestAgeMinutes: number;
}

/**
 * Renders the daily reminder: one message per reviewer for everything still waiting. Counts and an
 * age only; like the per-incident alert it carries no incident id, image, category or user data.
 */
export function renderIncidentReminderDigest(
  digest: IncidentReminderDigest,
  reviewUrl: string
): { subject: string; html: string } {
  const hours = Math.floor(digest.oldestAgeMinutes / 60);
  const rows: [string, string][] = [
    ['Incidents waiting', String(digest.pendingCount)],
    ['Oldest waiting', `${hours} ${hours === 1 ? 'hour' : 'hours'}`],
  ];
  const table = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`).join('');
  return {
    subject: 'Moderation reviews still pending',
    html:
      `<p>Moderation incidents are still waiting for a review verdict in the admin console.</p><table>${table}</table>` +
      `<p><a href="${escapeHtml(reviewUrl)}">${escapeHtml(reviewUrl)}</a></p>`,
  };
}

async function deliverToReviewers(
  buildEmail: (adminUrl: (path: string) => string) => { subject: string; html: string },
  meta: Record<string, string>,
  what: string,
  deps: IncidentReviewDelivery,
  options: { timeoutMs?: number }
): Promise<IncidentAlertOutcome> {
  const { valid: recipients, invalid } = partitionEmailList(await deps.getRecipients());
  if (invalid.length > 0) {
    deps.logger.warn(
      `[ImageModeration] ignoring ${invalid.length} invalid ImageModerationReviewerEmails entries`,
      meta
    );
  }
  if (recipients.length === 0) {
    deps.logger.warn(
      '[ImageModeration] incident needs review but no reviewer is configured (ImageModerationReviewerEmails)',
      meta
    );
    return 'no_recipients';
  }

  const baseUrl = deps.appUrl()?.trim();
  const email = buildEmail(path => (baseUrl ? toAbsoluteUrl(baseUrl, path) : path));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? REVIEW_ALERT_TIMEOUT_MS);
  });
  // One message per reviewer: a shared To header would show each reviewer the others' addresses.
  const deliver = async () =>
    (await Promise.all(recipients.map(recipient => deps.sendEmail(recipient, email)))).every(
      result => result !== false
    );
  try {
    const outcome = await Promise.race([deliver(), timedOut]);
    if (outcome === 'timeout') {
      deps.logger.error(`[ImageModeration] reviewer ${what} did not complete in time`, meta);
      return 'failed';
    }
    if (outcome === false) {
      deps.logger.error(`[ImageModeration] reviewer ${what} failed to send`, meta);
      return 'failed';
    }
    return 'delivered';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the metadata-only alert for one incident to every configured reviewer, without stamping
 * anything: the caller decides which timestamp a delivery records. Shared by the request path
 * (withReviewerAlerts) and the scheduled sweep so both render and log identically. The send budget
 * defaults to the request path's; the sweep has no request to protect and passes a longer one.
 */
export function deliverIncidentAlert(
  incident: RecordedIncident,
  deps: IncidentReviewDelivery,
  options: { timeoutMs?: number } = {}
): Promise<IncidentAlertOutcome> {
  return deliverToReviewers(
    adminUrl => renderIncidentReviewAlert(incident, adminUrl(adminModerationIncidentPath(incident.id))),
    { incidentId: incident.id },
    'alert',
    deps,
    options
  );
}

/** Sends the daily reminder digest to every configured reviewer; the caller stamps what it covered. */
export function deliverReminderDigest(
  digest: IncidentReminderDigest,
  deps: IncidentReviewDelivery,
  options: { timeoutMs?: number } = {}
): Promise<IncidentAlertOutcome> {
  return deliverToReviewers(
    adminUrl => renderIncidentReminderDigest(digest, adminUrl(ADMIN_CONSOLE_PATH)),
    { pendingCount: String(digest.pendingCount) },
    'reminder',
    deps,
    options
  );
}

async function alertReviewers(incident: RecordedIncident, deps: IncidentReviewAlertDeps): Promise<void> {
  if ((await deliverIncidentAlert(incident, deps)) !== 'delivered') return;
  try {
    await deps.incidents.markAlerted(incident.id);
  } catch {
    deps.logger.error('[ImageModeration] reviewer alert sent but alertedAt was not recorded', {
      incidentId: incident.id,
    });
  }
}

/**
 * Wraps the incident store so every incident that needs review alerts the configured reviewers.
 * The alert runs only after `record` resolves, so it is keyed to the one durable write: a failed
 * write alerts nobody, and a retried request that records a second incident alerts for that one.
 * A delivered alert stamps alertedAt. Alert failures are logged with the incident id alone (never a
 * recipient) and never reach the caller.
 */
export function withReviewerAlerts(
  deps: IncidentReviewAlertDeps
): Pick<IncidentReviewAlertDeps['incidents'], 'record'> {
  return {
    async record(input) {
      const incident = await deps.incidents.record(input);
      if (needsReview(incident)) {
        try {
          await alertReviewers(incident, deps);
        } catch {
          deps.logger.error('[ImageModeration] reviewer alert failed', { incidentId: incident.id });
        }
      }
      return incident;
    },
  };
}
