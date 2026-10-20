/**
 * CloudWatch namespace and metric names for voice credit-hold metrics. Emitted by
 * apps/workers/src/cron/voiceHoldSweep.ts; the voiceStaleHoldsSettled and voiceHoldSweepFailures
 * alarms in infra/alarms.ts watch them. Renaming a value starts a new CloudWatch series and
 * orphans the existing history.
 */
export const VOICE_NAMESPACE = 'Lumina5/Voice';

export const VOICE_METRICS = {
  HoldSweepSettled: 'HoldSweepSettled',
  HoldSweepFailed: 'HoldSweepFailed',
} as const;

export type VoiceMetricName = (typeof VOICE_METRICS)[keyof typeof VOICE_METRICS];
