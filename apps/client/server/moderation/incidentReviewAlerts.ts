import {
  adminModerationIncidentPath,
  toAbsoluteUrl,
  type ImageModerationIncident,
  type IncidentSurface,
  type ModerationLabelHit,
} from '@bike4mind/common';

/** The fields of a stored incident the alert reads; anything else on the record is never rendered. */
export interface RecordedIncident {
  id: string;
  createdAt: Date | string;
  surface?: IncidentSurface;
  labels: ModerationLabelHit[];
  reviewStatus?: ImageModerationIncident['reviewStatus'];
}

export interface IncidentReviewAlertDeps {
  incidents: { record(input: ImageModerationIncident): Promise<RecordedIncident> };
  getRecipients: () => Promise<string[]>;
  /** Mirrors MailService.sendEmail: resolves false (or rejects) when delivery failed. */
  sendEmail: (to: string, email: { subject: string; html: string }) => Promise<unknown>;
  appUrl: () => string | undefined;
  logger: { warn(msg: string, meta: unknown): void; error(msg: string, meta: unknown): void };
}

// Recording sits on the image request path, and the SMTP transport's own timeouts add up to tens
// of seconds, so the alert gets a short budget and anything slower is logged as undelivered.
export const REVIEW_ALERT_TIMEOUT_MS = 5_000;

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Renders the reviewer alert from an allowlist of incident metadata. It must never carry the image,
 * a stored-file key or URL, the prompt, or anything identifying the user: it goes to a mailbox and
 * the email-audit Slack mirror, neither of which is an access-controlled review surface.
 */
export function renderIncidentReviewAlert(
  incident: RecordedIncident,
  reviewUrl: string
): { subject: string; html: string } {
  const createdAt = new Date(incident.createdAt).toISOString();
  const categories = [...new Set(incident.labels.map(label => label.name))].join(', ') || 'unspecified';
  const rows: [string, string][] = [
    ['Incident', incident.id],
    ['Created', createdAt],
    ['Surface', incident.surface ?? 'unknown'],
    ['Category', categories],
  ];
  const table = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`).join('');
  return {
    subject: 'Image moderation incident needs review',
    html:
      `<p>An image moderation incident is waiting for review.</p><table>${table}</table>` +
      `<p><a href="${escapeHtml(reviewUrl)}">${escapeHtml(reviewUrl)}</a></p>`,
  };
}

const needsReview = (incident: RecordedIncident) =>
  !incident.reviewStatus || incident.reviewStatus === 'pending_review';

async function alertReviewers(incident: RecordedIncident, deps: IncidentReviewAlertDeps): Promise<void> {
  const meta = { incidentId: incident.id };
  const recipients = [...new Set((await deps.getRecipients()).map(to => to.trim().toLowerCase()).filter(Boolean))];
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
  const sends = Promise.allSettled(recipients.map(to => deps.sendEmail(to, email)));
  try {
    const outcome = await Promise.race([sends, timedOut]);
    if (outcome === 'timeout') {
      deps.logger.error('[ImageModeration] reviewer alert did not complete in time', meta);
      return;
    }
    if (outcome.some(result => result.status === 'rejected' || result.value === false)) {
      deps.logger.error('[ImageModeration] reviewer alert failed to send', meta);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps the incident store so every incident that needs review alerts the configured reviewers.
 * The alert runs only after `record` resolves, so it is keyed to the one durable write: a failed
 * write alerts nobody, and a retried request that records a second incident alerts for that one.
 * Alert failures are logged with the incident id alone and never reach the caller.
 */
export function withReviewerAlerts(deps: IncidentReviewAlertDeps): IncidentReviewAlertDeps['incidents'] {
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
