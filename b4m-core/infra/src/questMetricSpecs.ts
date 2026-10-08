/**
 * CloudWatch namespace and metric names for quest-lifecycle metrics. Emitted by
 * apps/client/server/chatCompletion/processingFailedMetric.ts and apps/workers/src/cron/questTimeoutSweep.ts;
 * the questProcessingFailures alarm in infra/alarms.ts watches ProcessingFailed. Renaming a value
 * starts a new CloudWatch series and orphans the existing history and dashboards.
 */
export const QUESTS_NAMESPACE = 'Lumina5/Quests';

export const QUEST_METRICS = {
  ProcessingFailed: 'ProcessingFailed',
  TimeoutSweepRuns: 'TimeoutSweepRuns',
  TimeoutSweepCandidates: 'TimeoutSweepCandidates',
  TimeoutSweepRecovered: 'TimeoutSweepRecovered',
  TimeoutSweepCallbacksRedispatched: 'TimeoutSweepCallbacksRedispatched',
  TimeoutSweepStaleCallbacksReenqueued: 'TimeoutSweepStaleCallbacksReenqueued',
} as const;

export type QuestMetricName = (typeof QUEST_METRICS)[keyof typeof QUEST_METRICS];
