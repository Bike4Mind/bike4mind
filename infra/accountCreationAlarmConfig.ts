export const SIGNUP_ALARM_PER_HOUR_DEFAULT = 8;
export const NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR_DEFAULT = 5;

export function accountCreationAlarmThreshold(raw: string | undefined, name: string, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export function accountCreationAlarmArgs(metricName: string, threshold: number) {
  return {
    metricName,
    threshold,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    period: 3600,
    statistic: 'Maximum',
    treatMissingData: 'notBreaching',
  };
}

export function emailRateThreshold(raw: string | undefined, name: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`${name} must be in (0, 100]`);
  return value;
}

export function emailRateQueries(metricName: 'Bounce' | 'Complaint', configurationSet: string) {
  return [
    {
      id: 'rate',
      expression: 'IF(FILL(sent, 0) > 0, 100 * FILL(events, 0) / FILL(sent, 0), IF(FILL(events, 0) > 0, 100, 0))',
      returnData: true,
    },
    ...[
      { id: 'sent', name: 'Send' },
      { id: 'events', name: metricName },
    ].map(metric => ({
      id: metric.id,
      returnData: false,
      metric: {
        namespace: 'AWS/SES',
        metricName: metric.name,
        period: 3600,
        stat: 'Sum',
        dimensions: { 'ses:configuration-set': configurationSet },
      },
    })),
  ];
}
