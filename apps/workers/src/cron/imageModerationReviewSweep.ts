/**
 * Re-sends the reviewer alert for image moderation incidents nobody was told about (none configured
 * when it was recorded, or the send failed) and sends a daily reminder digest (counts only, one
 * email per reviewer) for incidents still awaiting a verdict. Escalates incidents that waited too
 * long to the second review step, sends any escalation email still owed, and reminds the second
 * reviewers daily on their own schedule. All of it is metadata
 * only and goes through the same delivery as the request path
 * (packages/server-utils/src/moderation/incidentReviewSweep.ts).
 *
 * Publishes the oldest unalerted and oldest pending incident ages and a reviewer-list-empty flag
 * on every run; the alarms in infra/imageModerationReviewAlarms.ts watch them.
 *
 * Schedule: rate(15 minutes) (REVIEW_SWEEP_INTERVAL_MINUTES).
 */
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { connectDB, imageModerationIncidentRepository } from '@bike4mind/database';
import { IMAGE_MODERATION_REVIEW_METRICS, IMAGE_MODERATION_REVIEW_NAMESPACE } from '@bike4mind/infra';
import { Logger } from '@bike4mind/observability';
import {
  runIncidentReviewSweep,
  type IncidentReviewSweepDeps,
} from '@bike4mind/server-utils/moderation/incidentReviewSweep';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { Config } from '@bike4mind/server-utils/utils/config';
import { createReviewerAlertDelivery } from '@bike4mind/server-utils/moderation/imageModerationIncidents';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'imageModerationReviewSweep' } });

type StoredIncident = Awaited<ReturnType<typeof imageModerationIncidentRepository.findPendingReview>>[number];

// Lean rows carry _id, not the id virtual.
const toRecorded = (doc: StoredIncident) => ({
  id: String(doc._id),
  createdAt: doc.createdAt,
  surface: doc.surface,
  reviewStatus: doc.reviewStatus,
  escalatedAt: doc.escalatedAt,
});

const incidents: IncidentReviewSweepDeps['incidents'] = {
  findUnalerted: async (createdBefore, limit, queuedBefore, lostBefore) =>
    (await imageModerationIncidentRepository.findUnalerted(createdBefore, limit, queuedBefore, lostBefore)).map(
      toRecorded
    ),
  findDueForReminder: async (notifiedBefore, limit) =>
    (await imageModerationIncidentRepository.findDueForReminder(notifiedBefore, limit)).map(toRecorded),
  findOldestPending: async () => {
    const [oldest] = await imageModerationIncidentRepository.findPendingReview(1);
    return oldest && toRecorded(oldest);
  },
  markAlerted: (id, at) => imageModerationIncidentRepository.markAlerted(id, at),
  markAlertQueued: (id, at) => imageModerationIncidentRepository.markAlertQueued(id, at),
  countPending: () => imageModerationIncidentRepository.countPendingReview(),
  markReminded: (ids, at) => imageModerationIncidentRepository.markReminded(ids, at),
  findDueForEscalation: async (createdBefore, limit) =>
    (await imageModerationIncidentRepository.findDueForEscalation(createdBefore, limit)).map(toRecorded),
  escalateOnTimeout: async (id, at) => {
    const escalated = await imageModerationIncidentRepository.escalate(id, { trigger: 'timeout' }, at);
    return escalated && toRecorded(escalated);
  },
  findEscalationUnalerted: async (limit, queuedBefore, lostBefore) =>
    (await imageModerationIncidentRepository.findEscalationUnalerted(limit, queuedBefore, lostBefore)).map(toRecorded),
  markEscalationAlerted: (id, at) => imageModerationIncidentRepository.markEscalationAlerted(id, at),
  markEscalationAlertQueued: (id, at) => imageModerationIncidentRepository.markEscalationAlertQueued(id, at),
  findDueForEscalationReminder: async (notifiedBefore, limit) =>
    (await imageModerationIncidentRepository.findDueForEscalationReminder(notifiedBefore, limit)).map(toRecorded),
  markEscalationReminded: (ids, at) => imageModerationIncidentRepository.markEscalationReminded(ids, at),
};

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage), undefined, { autoIndex: false, autoCreate: false });

  // The cached settings map could hold an emptied reviewer list for the life of a warm Lambda.
  const result = await runIncidentReviewSweep({
    ...createReviewerAlertDelivery({ skipSettingsCache: true }),
    incidents,
  });

  const metric = (name: string, value: number, unit: StandardUnit) => ({
    name,
    value,
    dimensions: { Stage: stage },
    unit,
  });
  await emitMetrics(IMAGE_MODERATION_REVIEW_NAMESPACE, [
    metric(
      IMAGE_MODERATION_REVIEW_METRICS.OldestUnalertedAgeMinutes,
      result.oldestUnalertedAgeMinutes,
      StandardUnit.None
    ),
    metric(IMAGE_MODERATION_REVIEW_METRICS.OldestPendingAgeMinutes, result.oldestPendingAgeMinutes, StandardUnit.None),
    metric(
      IMAGE_MODERATION_REVIEW_METRICS.PendingWithoutReviewers,
      result.pendingWithoutReviewers ? 1 : 0,
      StandardUnit.Count
    ),
  ]);

  logger.info('[imageModerationReviewSweep] sweep complete', result);
  return result;
}
