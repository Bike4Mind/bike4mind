import {
  adminModerationIncidentPath,
  partitionEmailList,
  toAbsoluteUrl,
  type ImageModerationIncident,
  type IncidentSurface,
} from '@bike4mind/common';
import type { EmailDeliveryRef } from '../utils/eventBus';
import { escapeHtml } from '../utils/mailer/emailHelpers';

/**
 * The fields of a stored incident the alerts read. The emails render only id, time and surface;
 * anything else on the record is never rendered.
 */
export interface RecordedIncident {
  id: string;
  createdAt: Date | string;
  surface?: IncidentSurface;
  reviewStatus?: ImageModerationIncident['reviewStatus'];
  escalatedAt?: Date | string;
}

export interface IncidentReviewAlertDeps {
  incidents: {
    record(input: ImageModerationIncident): Promise<RecordedIncident>;
    markAlerted(id: string): Promise<void>;
    markAlertQueued(id: string): Promise<void>;
  };
  /** The stored ImageModerationReviewerEmails value; entries are validated one at a time here. */
  getRecipients: () => Promise<unknown>;
  /**
   * Mirrors queuedMailer.sendEmail for a single recipient: false when the send failed, `{ queued: true }`
   * when the email-send worker will deliver it (and report back through `ref`), any other object when
   * it was delivered inline.
   */
  sendEmail: (to: string, email: { subject: string; html: string }, ref?: EmailDeliveryRef) => Promise<false | object>;
  appUrl: () => string | undefined;
  logger: { warn(msg: string, meta: unknown): void; error(msg: string, meta: unknown): void };
}

// Recording sits on the image request path, so the alert gets a short budget. Self-host sends over
// SMTP in-process, whose own timeouts add up to tens of seconds; a send that misses the budget is
// best-effort (it may still land, unstamped).
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
  return renderIncidentEmail(
    incident,
    reviewUrl,
    'Moderation review pending',
    'A moderation incident is waiting in the admin console.'
  );
}

/** The escalation email: the same metadata allowlist as the reviewer alert, for the second review step. */
export function renderIncidentEscalationAlert(
  incident: RecordedIncident,
  reviewUrl: string
): { subject: string; html: string } {
  return renderIncidentEmail(
    incident,
    reviewUrl,
    'Moderation review escalated',
    'A moderation incident was escalated to the second review step and is waiting in the admin console.'
  );
}

function renderIncidentEmail(
  incident: RecordedIncident,
  reviewUrl: string,
  subject: string,
  lead: string
): { subject: string; html: string } {
  const rows: [string, string][] = [
    ['Incident id', incident.id],
    ['Created', new Date(incident.createdAt).toISOString()],
    ['Surface', incident.surface ?? 'unknown'],
  ];
  const table = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`).join('');
  return {
    subject,
    html:
      `<p>${lead}</p><table>${table}</table>` +
      `<p><a href="${escapeHtml(reviewUrl)}">${escapeHtml(reviewUrl)}</a></p>`,
  };
}

const needsReview = (incident: RecordedIncident) =>
  !incident.reviewStatus || incident.reviewStatus === 'pending_review';

/** The deps the alert needs to render and send, without the incident store. */
export type IncidentReviewDelivery = Omit<IncidentReviewAlertDeps, 'incidents'>;

/** Delivery that can also reach the second review step. */
export interface IncidentEscalationDelivery extends IncidentReviewDelivery {
  /** The stored ImageModerationEscalationEmails value; validated the same way as the reviewer list. */
  getEscalationRecipients: () => Promise<unknown>;
}

/** 'queued' means handed to the email-send worker, which stamps the delivery itself. */
export type IncidentAlertOutcome = 'delivered' | 'queued' | 'no_recipients' | 'failed';

/** Which reviewer list a send goes to. Warnings name the setting, never an address. */
interface RecipientList {
  read: () => Promise<unknown>;
  setting: 'ImageModerationReviewerEmails' | 'ImageModerationEscalationEmails';
  /** Logged when the list holds no valid address. */
  missing: string;
}

const firstReviewers = (deps: IncidentReviewDelivery): RecipientList => ({
  read: () => deps.getRecipients(),
  setting: 'ImageModerationReviewerEmails',
  missing: 'incident needs review but no reviewer is configured',
});

const escalationReviewers = (deps: IncidentEscalationDelivery): RecipientList => ({
  read: () => deps.getEscalationRecipients(),
  setting: 'ImageModerationEscalationEmails',
  missing: 'incident was escalated but no escalation reviewer is configured',
});

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
  list: RecipientList,
  buildEmail: (adminUrl: (path: string) => string) => { subject: string; html: string },
  meta: Record<string, string>,
  what: string,
  deps: IncidentReviewDelivery,
  options: { timeoutMs?: number },
  ref?: EmailDeliveryRef
): Promise<IncidentAlertOutcome> {
  const { valid: recipients, invalid } = partitionEmailList(await list.read());
  if (invalid.length > 0) {
    deps.logger.warn(`[ImageModeration] ignoring ${invalid.length} invalid ${list.setting} entries`, meta);
  }
  if (recipients.length === 0) {
    deps.logger.warn(`[ImageModeration] ${list.missing} (${list.setting})`, meta);
    return 'no_recipients';
  }

  const baseUrl = deps.appUrl()?.trim();
  const email = buildEmail(path => (baseUrl ? toAbsoluteUrl(baseUrl, path) : path));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? REVIEW_ALERT_TIMEOUT_MS);
  });
  // One message per reviewer: a shared To header would show each reviewer the others' addresses.
  // Digests carry no ref: nothing on an incident records their delivery.
  const send = (recipient: string) => (ref ? deps.sendEmail(recipient, email, ref) : deps.sendEmail(recipient, email));
  const deliver = () => Promise.all(recipients.map(send));
  const roundStart = new Date();
  try {
    const results = await Promise.race([deliver(), timedOut]);
    if (results === 'timeout') {
      deps.logger.error(`[ImageModeration] reviewer ${what} did not complete in time`, meta);
      return 'failed';
    }
    if (results.some(result => result === false)) {
      deps.logger.error(`[ImageModeration] reviewer ${what} failed to send`, meta);
      // The copies that were queued still report back; voiding the round keeps their delivery from
      // closing it, so the sweep resends to every reviewer.
      if (ref) await voidRound(ref, roundStart, meta, deps);
      return 'failed';
    }
    return results.every(isQueued) ? 'queued' : 'delivered';
  } finally {
    clearTimeout(timer);
  }
}

async function voidRound(
  ref: EmailDeliveryRef,
  roundStart: Date,
  meta: Record<string, string>,
  deps: IncidentReviewDelivery
): Promise<void> {
  try {
    const { voidIncidentAlertRound } = await import('../utils/mailer/deliveryOutcome');
    await voidIncidentAlertRound(ref, roundStart);
  } catch (error) {
    deps.logger.error('[ImageModeration] could not void a failed reviewer alert round', {
      ...meta,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

const isQueued = (result: false | object) =>
  typeof result === 'object' && (result as { queued?: unknown }).queued === true;

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
    firstReviewers(deps),
    adminUrl => renderIncidentReviewAlert(incident, adminUrl(adminModerationIncidentPath(incident.id))),
    { incidentId: incident.id },
    'alert',
    deps,
    options,
    { kind: 'incidentAlert', incidentId: incident.id, alert: 'review' }
  );
}

/** Sends the escalation email for one incident to the escalation list, without stamping anything. */
export function deliverEscalationAlert(
  incident: RecordedIncident,
  deps: IncidentEscalationDelivery,
  options: { timeoutMs?: number } = {}
): Promise<IncidentAlertOutcome> {
  return deliverToReviewers(
    escalationReviewers(deps),
    adminUrl => renderIncidentEscalationAlert(incident, adminUrl(adminModerationIncidentPath(incident.id))),
    { incidentId: incident.id },
    'escalation alert',
    deps,
    options,
    { kind: 'incidentAlert', incidentId: incident.id, alert: 'escalation' }
  );
}

/** Sends the daily reminder digest to every configured reviewer; the caller stamps what it covered. */
export function deliverReminderDigest(
  digest: IncidentReminderDigest,
  deps: IncidentReviewDelivery,
  options: { timeoutMs?: number } = {}
): Promise<IncidentAlertOutcome> {
  return deliverDigest(firstReviewers(deps), 'reminder', digest, deps, options);
}

/** Sends the same daily reminder digest to the escalation list. */
export function deliverEscalationReminderDigest(
  digest: IncidentReminderDigest,
  deps: IncidentEscalationDelivery,
  options: { timeoutMs?: number } = {}
): Promise<IncidentAlertOutcome> {
  return deliverDigest(escalationReviewers(deps), 'escalation reminder', digest, deps, options);
}

function deliverDigest(
  list: RecipientList,
  what: string,
  digest: IncidentReminderDigest,
  deps: IncidentReviewDelivery,
  options: { timeoutMs?: number }
): Promise<IncidentAlertOutcome> {
  return deliverToReviewers(
    list,
    adminUrl => renderIncidentReminderDigest(digest, adminUrl(ADMIN_CONSOLE_PATH)),
    { pendingCount: String(digest.pendingCount) },
    what,
    deps,
    options
  );
}

export interface IncidentEscalationAlertDeps extends IncidentEscalationDelivery {
  incidents: {
    markEscalationAlerted(id: string, at: Date): Promise<void>;
    markEscalationAlertQueued(id: string, at: Date): Promise<void>;
  };
}

/**
 * Sends the escalation email for an incident a reviewer just escalated. An inline delivery stamps
 * escalationAlertedAt; a queued one stamps escalationAlertQueuedAt and the email-send worker stamps
 * the delivery. Never throws: an undelivered or unstamped send is left for the review sweep to retry.
 * `alertedAt` and `queuedAt` are the stamps written, null when not written.
 */
export async function alertEscalationReviewers(
  incident: RecordedIncident,
  deps: IncidentEscalationAlertDeps,
  now: () => Date = () => new Date()
): Promise<{ outcome: IncidentAlertOutcome; alertedAt: Date | null; queuedAt: Date | null }> {
  let outcome: IncidentAlertOutcome;
  try {
    outcome = await deliverEscalationAlert(incident, deps);
  } catch {
    deps.logger.error('[ImageModeration] escalation alert failed', { incidentId: incident.id });
    return { outcome: 'failed', alertedAt: null, queuedAt: null };
  }
  if (outcome !== 'delivered' && outcome !== 'queued') return { outcome, alertedAt: null, queuedAt: null };
  const at = now();
  const queued = outcome === 'queued';
  try {
    if (queued) await deps.incidents.markEscalationAlertQueued(incident.id, at);
    else await deps.incidents.markEscalationAlerted(incident.id, at);
    return { outcome, alertedAt: queued ? null : at, queuedAt: queued ? at : null };
  } catch {
    deps.logger.error(
      `[ImageModeration] escalation alert sent but ${queued ? 'escalationAlertQueuedAt' : 'escalationAlertedAt'} was not recorded`,
      { incidentId: incident.id }
    );
    return { outcome, alertedAt: null, queuedAt: null };
  }
}

async function alertReviewers(incident: RecordedIncident, deps: IncidentReviewAlertDeps): Promise<void> {
  const outcome = await deliverIncidentAlert(incident, deps);
  if (outcome !== 'delivered' && outcome !== 'queued') return;
  try {
    if (outcome === 'queued') await deps.incidents.markAlertQueued(incident.id);
    else await deps.incidents.markAlerted(incident.id);
  } catch {
    deps.logger.error(
      `[ImageModeration] reviewer alert sent but ${outcome === 'queued' ? 'alertQueuedAt' : 'alertedAt'} was not recorded`,
      { incidentId: incident.id }
    );
  }
}

/**
 * Wraps the incident store so every incident that needs review alerts the configured reviewers.
 * The alert runs only after `record` resolves, so it is keyed to the one durable write: a failed
 * write alerts nobody, and a retried request that records a second incident alerts for that one.
 * An inline delivery stamps alertedAt; a queued one stamps alertQueuedAt. Alert failures are logged with the incident id alone (never a
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
