import {
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
  type CloudWatchClient,
  type MetricAlarm,
} from '@aws-sdk/client-cloudwatch';

/**
 * Admin-settings override of the hourly young-account spend alarms defined in infra/llmSpend.ts.
 * The settings hold USD per rolling hour; 0 or unset leaves the deployed threshold alone.
 */
export const YOUNG_ACCOUNT_ALARM_SETTING_KEYS = {
  page: 'youngAccountSpendPageUsdPerHour',
  warn: 'youngAccountSpendWarnUsdPerHour',
} as const;

export type YoungAccountAlarmTier = keyof typeof YOUNG_ACCOUNT_ALARM_SETTING_KEYS;
export type YoungAccountAlarmThresholds = Partial<Record<YoungAccountAlarmTier, number>>;

interface ReconcileLogger {
  log(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function positiveNumber(raw: unknown): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Stored admin settings are strings, so numeric strings count. */
export function desiredYoungAccountAlarmThresholds(settings: Record<string, unknown>): YoungAccountAlarmThresholds {
  const desired: YoungAccountAlarmThresholds = {};
  for (const tier of Object.keys(YOUNG_ACCOUNT_ALARM_SETTING_KEYS) as YoungAccountAlarmTier[]) {
    const value = positiveNumber(settings[YOUNG_ACCOUNT_ALARM_SETTING_KEYS[tier]]);
    if (value !== undefined) desired[tier] = value;
  }
  return desired;
}

/** PutMetricAlarm replaces the whole alarm, so every field the deploy set is carried over. */
function putWithThreshold(alarm: MetricAlarm, threshold: number): PutMetricAlarmCommand {
  return new PutMetricAlarmCommand({
    AlarmName: alarm.AlarmName,
    AlarmDescription: alarm.AlarmDescription,
    ActionsEnabled: alarm.ActionsEnabled,
    ComparisonOperator: alarm.ComparisonOperator,
    EvaluationPeriods: alarm.EvaluationPeriods,
    DatapointsToAlarm: alarm.DatapointsToAlarm,
    MetricName: alarm.MetricName,
    Namespace: alarm.Namespace,
    Dimensions: alarm.Dimensions,
    Period: alarm.Period,
    Statistic: alarm.Statistic,
    ExtendedStatistic: alarm.ExtendedStatistic,
    Unit: alarm.Unit,
    TreatMissingData: alarm.TreatMissingData,
    EvaluateLowSampleCountPercentile: alarm.EvaluateLowSampleCountPercentile,
    AlarmActions: alarm.AlarmActions,
    OKActions: alarm.OKActions,
    InsufficientDataActions: alarm.InsufficientDataActions,
    Threshold: threshold,
  });
}

/**
 * Applies the desired thresholds to the live alarms. An unset tier keeps whatever the last deploy
 * set. Never throws: the override is best-effort beside the spend alert that calls it.
 */
export async function reconcileYoungAccountAlarmThresholds({
  client,
  alarmNames,
  desired,
  logger,
}: {
  client: Pick<CloudWatchClient, 'send'>;
  alarmNames: Record<YoungAccountAlarmTier, string>;
  desired: YoungAccountAlarmThresholds;
  logger: ReconcileLogger;
}): Promise<void> {
  const tiers = (Object.keys(alarmNames) as YoungAccountAlarmTier[]).filter(tier => desired[tier] !== undefined);
  if (tiers.length === 0) return;

  try {
    const { MetricAlarms = [] } = await client.send(
      new DescribeAlarmsCommand({ AlarmNames: tiers.map(tier => alarmNames[tier]), AlarmTypes: ['MetricAlarm'] })
    );
    for (const tier of tiers) {
      const threshold = desired[tier] as number;
      const alarm = MetricAlarms.find(candidate => candidate.AlarmName === alarmNames[tier]);
      if (!alarm) {
        logger.error('young-account-alarm-threshold-missing-alarm', { alarmName: alarmNames[tier] });
        continue;
      }
      if (alarm.Threshold === threshold) continue;
      await client.send(putWithThreshold(alarm, threshold));
      logger.log('young-account-alarm-threshold-updated', {
        alarmName: alarm.AlarmName,
        oldThreshold: alarm.Threshold,
        newThreshold: threshold,
      });
    }
  } catch (error) {
    logger.error('young-account-alarm-threshold-reconcile-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
