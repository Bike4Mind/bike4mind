import { partitionEmailList } from '@bike4mind/common';
import { REVIEW_REMINDER_INTERVAL_HOURS, REVIEW_SWEEP_MIN_INCIDENT_AGE_MINUTES } from '@bike4mind/infra';
import {
  deliverIncidentAlert,
  deliverReminderDigest,
  type IncidentReviewDelivery,
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

export interface IncidentReviewSweepDeps extends IncidentReviewDelivery {
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
  };
}

export interface IncidentReviewSweepResult {
  alerted: number;
  /** Incidents covered by the reminder digest this run. */
  reminded: number;
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
 */
export async function runIncidentReviewSweep(
  sweepDeps: IncidentReviewSweepDeps,
  now: Date = new Date(),
  clock: () => number = Date.now
): Promise<IncidentReviewSweepResult> {
  // Read once: the delivery step reads the list per incident, and each read is an uncached settings query.
  const recipients = await sweepDeps.getRecipients();
  const deps: IncidentReviewSweepDeps = { ...sweepDeps, getRecipients: async () => recipients };
  const { incidents, logger } = deps;
  const startedAt = clock();
  const outOfBudget = () => clock() - startedAt >= REVIEW_SWEEP_SEND_BUDGET_MS;
  const result: IncidentReviewSweepResult = {
    alerted: 0,
    reminded: 0,
    failed: 0,
    oldestUnalertedAgeMinutes: 0,
    oldestPendingAgeMinutes: 0,
    pendingWithoutReviewers: false,
  };

  const reviewersConfigured = partitionEmailList(recipients).valid.length > 0;
  const oldestPending = await incidents.findOldestPending();

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

    const reminderCutoff = new Date(now.getTime() - REVIEW_REMINDER_INTERVAL_HOURS * HOUR_MS);
    const due = await incidents.findDueForReminder(reminderCutoff, REVIEW_SWEEP_REMINDER_LIMIT);
    if (due.length > 0 && !outOfBudget()) {
      const digest = {
        pendingCount: Math.max(await incidents.countPending(), due.length),
        oldestAgeMinutes: ageMinutes(oldestPending ?? due[0], now),
      };
      if (await sendDigest(digest, deps)) {
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

async function sendDigest(
  digest: { pendingCount: number; oldestAgeMinutes: number },
  deps: IncidentReviewSweepDeps
): Promise<boolean> {
  try {
    return (await deliverReminderDigest(digest, deps, { timeoutMs: REVIEW_SWEEP_SEND_TIMEOUT_MS })) === 'delivered';
  } catch (error) {
    deps.logger.error('[ImageModeration] review sweep reminder failed', {
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
