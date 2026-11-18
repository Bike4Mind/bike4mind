import { partitionEmailList } from '@bike4mind/common';
import { REVIEW_REMINDER_INTERVAL_HOURS, REVIEW_SWEEP_MIN_INCIDENT_AGE_MINUTES } from '@bike4mind/infra';
import {
  deliverEscalationAlert,
  deliverEscalationReminderDigest,
  deliverIncidentAlert,
  deliverReminderDigest,
  type IncidentEscalationDelivery,
  type IncidentReminderDigest,
  type RecordedIncident,
} from './incidentReviewAlerts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Per-run cap on each kind of send, oldest first; a backlog drains over successive runs. Each send
// has its own timeout budget, so the cap also bounds the run's duration.
export const REVIEW_SWEEP_BATCH_LIMIT = 20;
// Bounds the stamp write for one digest; a larger backlog is covered over successive runs.
export const REVIEW_SWEEP_REMINDER_LIMIT = 500;
// Longer than the request path's 5 s: a slow SMTP send that still lands would otherwise count as
// failed and be sent again 15 minutes later.
export const REVIEW_SWEEP_SEND_TIMEOUT_MS = 20_000;
// No new send starts past this, so one run stays inside the Lambda timeout (5 minutes) when SMTP
// is slow; the rest is picked up by the next run.
export const REVIEW_SWEEP_SEND_BUDGET_MS = 3 * MINUTE_MS;
// An incident still awaiting a verdict this long after it was recorded moves to the second review
// step. Kept here, not with the sweep specs, because no deployed resource reads it.
export const REVIEW_ESCALATION_TIMEOUT_HOURS = 24;

export interface IncidentReviewSweepDeps extends IncidentEscalationDelivery {
  incidents: {
    /** Unreviewed incidents created at or before the cutoff with no delivered alert, oldest first. */
    findUnalerted(createdBefore: Date, limit: number): Promise<RecordedIncident[]>;
    /** Alerted, unreviewed incidents whose last alert or reminder is at or before the cutoff, oldest first. */
    findDueForReminder(notifiedBefore: Date, limit: number): Promise<RecordedIncident[]>;
    /** Number of unreviewed incidents of any age. */
    countPending(): Promise<number>;
    /** The oldest unreviewed incident of any age. */
    findOldestPending(): Promise<RecordedIncident | undefined>;
    markAlerted(id: string, at: Date): Promise<void>;
    markReminded(ids: string[], at: Date): Promise<void>;
    /** Unreviewed, unescalated incidents created at or before the cutoff, oldest first. */
    findDueForEscalation(createdBefore: Date, limit: number): Promise<RecordedIncident[]>;
    /** Stamps a timeout escalation; null when the incident was escalated or decided meanwhile. */
    escalateOnTimeout(id: string, at: Date): Promise<RecordedIncident | null>;
    /** Escalated, unreviewed incidents with no delivered escalation email, oldest first. */
    findEscalationUnalerted(limit: number): Promise<RecordedIncident[]>;
    markEscalationAlerted(id: string, at: Date): Promise<void>;
    /** Escalated, unreviewed incidents whose escalation email or last escalation reminder is at or before the cutoff, oldest first. */
    findDueForEscalationReminder(notifiedBefore: Date, limit: number): Promise<RecordedIncident[]>;
    markEscalationReminded(ids: string[], at: Date): Promise<void>;
  };
}

export interface IncidentReviewSweepResult {
  alerted: number;
  /** Incidents covered by the reminder digest this run. */
  reminded: number;
  /** Incidents this run moved to the second review step because they waited too long. */
  escalated: number;
  /** Escalation emails delivered this run. */
  escalationAlerted: number;
  /** Incidents covered by the reminder digest to the second reviewers this run. */
  escalationReminded: number;
  failed: number;
  /** Age of the oldest incident still unalerted once the run is done; 0 when there is none. */
  oldestUnalertedAgeMinutes: number;
  /** Age of the oldest incident still awaiting a verdict; 0 when there is none. */
  oldestPendingAgeMinutes: number;
  /** True when an incident awaits a verdict and no valid reviewer address is configured. */
  pendingWithoutReviewers: boolean;
}

// The error name only: a mailer error message can carry recipient addresses, which never reach logs.
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

const ageMinutes = (incident: RecordedIncident | undefined, now: Date) =>
  incident ? Math.max(0, Math.floor((now.getTime() - new Date(incident.createdAt).getTime()) / MINUTE_MS)) : 0;

/**
 * Reconciles reviewer alerts for image moderation incidents. The request path alerts once and
 * never retries, so an incident recorded while no reviewer was configured, or while the send
 * failed, stays unalerted. This re-sends that alert for incidents past a short grace period, and
 * sends one digest per run, covering every incident whose last notice is a full interval old. It reuses the request
 * path's delivery, so the email stays metadata only, and it logs incident ids and counts, never a
 * recipient. A failure on one incident never stops the rest; the next run retries it.
 *
 * It also runs the second review step: an incident still pending REVIEW_ESCALATION_TIMEOUT_HOURS after
 * it was recorded is escalated (no admin actor, so the stamps are the record), and every escalated,
 * still-pending incident whose escalation email was not delivered gets it, whether a reviewer or this
 * sweep escalated it. The second reviewers get their own digest, one per run, for escalated incidents
 * whose escalation email or last escalation digest is a full interval old.
 */
export async function runIncidentReviewSweep(
  sweepDeps: IncidentReviewSweepDeps,
  now: Date = new Date(),
  clock: () => number = Date.now
): Promise<IncidentReviewSweepResult> {
  // Read each list once: the delivery step reads it per incident, and each read is an uncached settings query.
  const recipients = await sweepDeps.getRecipients();
  const escalationRecipients = await sweepDeps.getEscalationRecipients();
  const deps: IncidentReviewSweepDeps = {
    ...sweepDeps,
    getRecipients: async () => recipients,
    getEscalationRecipients: async () => escalationRecipients,
  };
  const { incidents, logger } = deps;
  const startedAt = clock();
  const outOfBudget = () => clock() - startedAt >= REVIEW_SWEEP_SEND_BUDGET_MS;
  const result: IncidentReviewSweepResult = {
    alerted: 0,
    reminded: 0,
    escalated: 0,
    escalationAlerted: 0,
    escalationReminded: 0,
    failed: 0,
    oldestUnalertedAgeMinutes: 0,
    oldestPendingAgeMinutes: 0,
    pendingWithoutReviewers: false,
  };

  const reviewersConfigured = partitionEmailList(recipients).valid.length > 0;
  const escalationConfigured = partitionEmailList(escalationRecipients).valid.length > 0;
  const oldestPending = await incidents.findOldestPending();
  const reminderCutoff = new Date(now.getTime() - REVIEW_REMINDER_INTERVAL_HOURS * HOUR_MS);
  const digestFor = async (due: RecordedIncident[]): Promise<IncidentReminderDigest> => ({
    pendingCount: Math.max(await incidents.countPending(), due.length),
    oldestAgeMinutes: ageMinutes(oldestPending ?? due[0], now),
  });

  if (reviewersConfigured) {
    const graceCutoff = new Date(now.getTime() - REVIEW_SWEEP_MIN_INCIDENT_AGE_MINUTES * MINUTE_MS);
    const unalerted = await incidents.findUnalerted(graceCutoff, REVIEW_SWEEP_BATCH_LIMIT);
    for (const incident of unalerted) {
      if (outOfBudget()) break;
      if (await sendAlert(incident, deps)) {
        result.alerted++;
        await stamp(() => incidents.markAlerted(incident.id, now), 'alertedAt', { incidentId: incident.id }, deps);
      } else {
        result.failed++;
      }
    }

    const due = await incidents.findDueForReminder(reminderCutoff, REVIEW_SWEEP_REMINDER_LIMIT);
    if (due.length > 0 && !outOfBudget()) {
      if (await sendDigest(await digestFor(due), deps)) {
        result.reminded = due.length;
        await stamp(
          () =>
            incidents.markReminded(
              due.map(incident => incident.id),
              now
            ),
          'lastReminderAt',
          { covered: due.length },
          deps
        );
      } else {
        result.failed++;
      }
    }
  } else if (oldestPending) {
    logger.warn(
      '[ImageModeration] incidents await review but no reviewer is configured (ImageModerationReviewerEmails)',
      { oldestIncidentId: oldestPending.id }
    );
  }

  const escalationCutoff = new Date(now.getTime() - REVIEW_ESCALATION_TIMEOUT_HOURS * HOUR_MS);
  for (const incident of await incidents.findDueForEscalation(escalationCutoff, REVIEW_SWEEP_BATCH_LIMIT)) {
    try {
      if (await incidents.escalateOnTimeout(incident.id, now)) result.escalated++;
    } catch (error) {
      logger.error('[ImageModeration] review sweep could not escalate an incident', {
        incidentId: incident.id,
        errorName: errorName(error),
      });
    }
  }

  const owed = await incidents.findEscalationUnalerted(REVIEW_SWEEP_BATCH_LIMIT);
  if (escalationConfigured) {
    for (const incident of owed) {
      if (outOfBudget()) break;
      if (await sendEscalation(incident, deps)) {
        result.escalationAlerted++;
        await stamp(
          () => incidents.markEscalationAlerted(incident.id, now),
          'escalationAlertedAt',
          { incidentId: incident.id },
          deps
        );
      } else {
        result.failed++;
      }
    }

    // Runs on its own stamp, not the first list's, so the second reviewers are reminded even while
    // the first list is empty or its digest is failing.
    const dueEscalated = await incidents.findDueForEscalationReminder(reminderCutoff, REVIEW_SWEEP_REMINDER_LIMIT);
    if (dueEscalated.length > 0 && !outOfBudget()) {
      if (await sendDigest(await digestFor(dueEscalated), deps, 'escalation')) {
        result.escalationReminded = dueEscalated.length;
        await stamp(
          () =>
            incidents.markEscalationReminded(
              dueEscalated.map(incident => incident.id),
              now
            ),
          'escalationLastReminderAt',
          { covered: dueEscalated.length },
          deps
        );
      } else {
        result.failed++;
      }
    }
  } else if (owed.length > 0) {
    logger.warn(
      '[ImageModeration] incidents were escalated but no escalation reviewer is configured (ImageModerationEscalationEmails)',
      { oldestIncidentId: owed[0].id }
    );
  }

  // Read after the sends so an incident this run alerted does not count against the alarm.
  const [oldestUnalerted] = await incidents.findUnalerted(now, 1);
  result.oldestUnalertedAgeMinutes = ageMinutes(oldestUnalerted, now);
  result.oldestPendingAgeMinutes = ageMinutes(oldestPending, now);
  result.pendingWithoutReviewers = !reviewersConfigured && oldestPending !== undefined;
  return result;
}

async function sendAlert(incident: RecordedIncident, deps: IncidentReviewSweepDeps): Promise<boolean> {
  try {
    return (await deliverIncidentAlert(incident, deps, { timeoutMs: REVIEW_SWEEP_SEND_TIMEOUT_MS })) === 'delivered';
  } catch (error) {
    deps.logger.error('[ImageModeration] review sweep alert failed', {
      incidentId: incident.id,
      errorName: errorName(error),
    });
    return false;
  }
}

async function sendEscalation(incident: RecordedIncident, deps: IncidentReviewSweepDeps): Promise<boolean> {
  try {
    return (await deliverEscalationAlert(incident, deps, { timeoutMs: REVIEW_SWEEP_SEND_TIMEOUT_MS })) === 'delivered';
  } catch (error) {
    deps.logger.error('[ImageModeration] review sweep escalation alert failed', {
      incidentId: incident.id,
      errorName: errorName(error),
    });
    return false;
  }
}

async function sendDigest(
  digest: IncidentReminderDigest,
  deps: IncidentReviewSweepDeps,
  to: 'reviewers' | 'escalation' = 'reviewers'
): Promise<boolean> {
  const deliver = to === 'escalation' ? deliverEscalationReminderDigest : deliverReminderDigest;
  try {
    return (await deliver(digest, deps, { timeoutMs: REVIEW_SWEEP_SEND_TIMEOUT_MS })) === 'delivered';
  } catch (error) {
    deps.logger.error(`[ImageModeration] review sweep ${to === 'escalation' ? 'escalation ' : ''}reminder failed`, {
      pendingCount: digest.pendingCount,
      errorName: errorName(error),
    });
    return false;
  }
}

async function stamp(
  write: () => Promise<void>,
  field: string,
  meta: Record<string, string | number>,
  deps: IncidentReviewSweepDeps
): Promise<void> {
  try {
    await write();
  } catch (error) {
    deps.logger.error(`[ImageModeration] review sweep sent but ${field} was not recorded`, {
      ...meta,
      errorName: errorName(error),
    });
  }
}
