/**
 * Alarms on the image moderation review sweep (apps/workers/src/cron/imageModerationReviewSweep.ts):
 * an incident nobody was alerted about, an incident awaiting a verdict for a day, and incidents
 * awaiting review with no reviewer configured. The sweep publishes all three series every run, 0
 * when clear, so a missing datapoint is read as OK.
 */

import {
  IMAGE_MODERATION_REVIEW_METRICS,
  IMAGE_MODERATION_REVIEW_NAMESPACE,
  PENDING_INCIDENT_ALARM_MINUTES,
  REVIEW_SWEEP_INTERVAL_MINUTES,
  UNALERTED_INCIDENT_ALARM_MINUTES,
  isMonitoredStage as _isMonitoredStage,
} from '@bike4mind/infra';
import { dlqAlarmTopic } from './dlqAlarms';
import { imageModerationReviewSweepDeadLetter } from './imageModerationReviewSweepDeadLetter';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

// The sweep cron only exists on scheduled stages; an ENABLE_MONITORING preview has nothing to watch.
if (isMonitoredStage && imageModerationReviewSweepDeadLetter) {
  if (!dlqAlarmTopic) throw new Error('image moderation review alarms require dlqAlarmTopic');

  /**
   * Alarm: Image moderation incident has no delivered alert
   *
   * The oldest incident still without a delivered alert, after the sweep has had its try, is older
   * than the threshold. The sweep re-sends every run, so this means the send keeps failing or no
   * reviewer is configured. Plain-English text lives in apps/workers/src/events/alarmSlackMessage.ts.
   *
   * Metric emitted by: apps/workers/src/cron/imageModerationReviewSweep.ts -> handler.
   */
  new aws.cloudwatch.MetricAlarm('imageModerationIncidentUnalerted', {
    name: `${$app.name}-${$app.stage}-image-moderation-incident-unalerted`,
    alarmDescription: 'An image moderation incident has gone without a reviewer alert for over 30 minutes',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: IMAGE_MODERATION_REVIEW_METRICS.OldestUnalertedAgeMinutes,
    namespace: IMAGE_MODERATION_REVIEW_NAMESPACE,
    period: REVIEW_SWEEP_INTERVAL_MINUTES * 60,
    statistic: 'Maximum',
    threshold: UNALERTED_INCIDENT_ALARM_MINUTES,
    treatMissingData: 'notBreaching',
    dimensions: { Stage: $app.stage },
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: {
      Application: 'Moderation',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Image moderation incident awaiting a verdict for a day
   *
   * The oldest incident still awaiting a verdict is older than the threshold, alerted or not. The
   * sweep sends one reminder a day meanwhile; only a recorded verdict clears it.
   *
   * Metric emitted by: apps/workers/src/cron/imageModerationReviewSweep.ts -> handler.
   */
  new aws.cloudwatch.MetricAlarm('imageModerationIncidentUnreviewed', {
    name: `${$app.name}-${$app.stage}-image-moderation-incident-unreviewed`,
    alarmDescription: 'An image moderation incident has been waiting for a review verdict for over 24 hours',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: IMAGE_MODERATION_REVIEW_METRICS.OldestPendingAgeMinutes,
    namespace: IMAGE_MODERATION_REVIEW_NAMESPACE,
    period: REVIEW_SWEEP_INTERVAL_MINUTES * 60,
    statistic: 'Maximum',
    threshold: PENDING_INCIDENT_ALARM_MINUTES,
    treatMissingData: 'notBreaching',
    dimensions: { Stage: $app.stage },
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: {
      Application: 'Moderation',
      Severity: 'High',
    },
  });

  /**
   * Alarm: Image moderation reviewer list is empty
   *
   * An incident is awaiting review and no valid reviewer address is configured
   * (ImageModerationReviewerEmails), so nobody can be alerted.
   *
   * Metric emitted by: apps/workers/src/cron/imageModerationReviewSweep.ts -> handler.
   */
  new aws.cloudwatch.MetricAlarm('imageModerationNoReviewers', {
    name: `${$app.name}-${$app.stage}-image-moderation-no-reviewers`,
    alarmDescription: 'Image moderation incidents are waiting for review and no reviewer address is configured',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: IMAGE_MODERATION_REVIEW_METRICS.PendingWithoutReviewers,
    namespace: IMAGE_MODERATION_REVIEW_NAMESPACE,
    period: REVIEW_SWEEP_INTERVAL_MINUTES * 60,
    statistic: 'Maximum',
    threshold: 0,
    treatMissingData: 'notBreaching',
    dimensions: { Stage: $app.stage },
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: {
      Application: 'Moderation',
      Severity: 'High',
    },
  });
}
