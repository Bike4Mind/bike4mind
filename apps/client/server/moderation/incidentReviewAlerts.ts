import {
  adminModerationIncidentPath,
  partitionEmailList,
  toAbsoluteUrl,
  type ImageModerationIncident,
  type IncidentSurface,
} from '@bike4mind/common';

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

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

async function alertReviewers(incident: RecordedIncident, deps: IncidentReviewAlertDeps): Promise<void> {
  const meta = { incidentId: incident.id };
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
    return;
  }

  const path = adminModerationIncidentPath(incident.id);
  const baseUrl = deps.appUrl()?.trim();
  const email = renderIncidentReviewAlert(incident, baseUrl ? toAbsoluteUrl(baseUrl, path) : path);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), REVIEW_ALERT_TIMEOUT_MS);
  });
  // One message per reviewer: a shared To header would show each reviewer the others' addresses.
  const deliver = async () =>
    (await Promise.all(recipients.map(recipient => deps.sendEmail(recipient, email)))).every(
      result => result !== false
    );
  try {
    const outcome = await Promise.race([deliver(), timedOut]);
    if (outcome === 'timeout') {
      deps.logger.error('[ImageModeration] reviewer alert did not complete in time', meta);
      return;
    }
    if (outcome === false) {
      deps.logger.error('[ImageModeration] reviewer alert failed to send', meta);
      return;
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    await deps.incidents.markAlerted(incident.id);
  } catch {
    deps.logger.error('[ImageModeration] reviewer alert sent but alertedAt was not recorded', meta);
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
