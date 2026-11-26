import { DescribeAlarmsCommand, type CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { positiveAlarmThreshold, putWithThreshold, type ReconcileLogger } from './youngAccountSpendAlarmThresholds';

/**
 * Admin-settings override of the hourly provider-reported spend alarms defined in infra/providerSpend.ts.
 * The settings hold USD per hour; 0 or unset leaves the current threshold unchanged.
 */
export const PROVIDER_SPEND_ALARM_SETTING_KEYS = {
  openai: 'providerSpendOpenaiUsdPerHour',
  anthropic: 'providerSpendAnthropicUsdPerHour',
} as const;

export type ProviderSpendAlarmProvider = keyof typeof PROVIDER_SPEND_ALARM_SETTING_KEYS;
export type ProviderSpendAlarmThresholds = Partial<Record<ProviderSpendAlarmProvider, number>>;

/** Stored admin settings are strings, so numeric strings count. */
export function desiredProviderSpendAlarmThresholds(settings: Record<string, unknown>): ProviderSpendAlarmThresholds {
  const desired: ProviderSpendAlarmThresholds = {};
  for (const provider of Object.keys(PROVIDER_SPEND_ALARM_SETTING_KEYS) as ProviderSpendAlarmProvider[]) {
    const value = positiveAlarmThreshold(settings[PROVIDER_SPEND_ALARM_SETTING_KEYS[provider]]);
    if (value !== undefined) desired[provider] = value;
  }
  return desired;
}

/**
 * Applies the desired thresholds to the live alarms named in alarmNames; a provider without a name
 * or a desired threshold is left alone. Never throws: the override is best-effort beside its caller.
 */
export async function reconcileProviderSpendAlarmThresholds({
  client,
  alarmNames,
  desired,
  logger,
}: {
  client: Pick<CloudWatchClient, 'send'>;
  alarmNames: Partial<Record<ProviderSpendAlarmProvider, string>>;
  desired: ProviderSpendAlarmThresholds;
  logger: ReconcileLogger;
}): Promise<void> {
  const targets = (Object.keys(alarmNames) as ProviderSpendAlarmProvider[]).flatMap(provider => {
    const alarmName = alarmNames[provider];
    const threshold = desired[provider];
    return alarmName && threshold !== undefined ? [{ alarmName, threshold }] : [];
  });
  if (targets.length === 0) return;

  try {
    const { MetricAlarms = [] } = await client.send(
      new DescribeAlarmsCommand({ AlarmNames: targets.map(target => target.alarmName), AlarmTypes: ['MetricAlarm'] })
    );
    for (const { alarmName, threshold } of targets) {
      const alarm = MetricAlarms.find(candidate => candidate.AlarmName === alarmName);
      if (!alarm) {
        logger.error('provider-spend-alarm-threshold-missing-alarm', { alarmName });
        continue;
      }
      if (alarm.Threshold === threshold) continue;
      try {
        await client.send(putWithThreshold(alarm, threshold));
        logger.log('provider-spend-alarm-threshold-updated', {
          alarmName,
          oldThreshold: alarm.Threshold,
          newThreshold: threshold,
        });
      } catch (error) {
        logger.error('provider-spend-alarm-threshold-update-failed', {
          alarmName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.error('provider-spend-alarm-threshold-reconcile-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
