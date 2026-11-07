// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../alarms.ts', import.meta.url), 'utf8');
const start = source.indexOf("new aws.cloudwatch.MetricAlarm('subscriptionReconciliationTruncated', {");
const end = source.indexOf('\n  });', start);
const alarm = source.slice(start, end);

// Bound to this constructor so a neighboring alarm cannot satisfy a missing property.
const properties = [
  "comparisonOperator: 'GreaterThanThreshold'",
  'evaluationPeriods: 2',
  'datapointsToAlarm: 2',
  "metricName: 'ReconciliationTruncated'",
  "namespace: 'Lumina5/Billing'",
  'dimensions: { Stage: $app.stage }',
  'period: 86400',
  "statistic: 'Maximum'",
  'threshold: 0',
  "treatMissingData: 'notBreaching'",
  'alarmActions: [dlqAlarmTopic.arn]',
];

describe('subscription reconciliation truncation alarm', () => {
  it('alerts on two consecutive daily truncated runs and routes to the monitored-stage alarm topic', () => {
    expect(start).toBeGreaterThan(source.indexOf('if (isMonitoredStage)'));
    expect(end).toBeGreaterThan(start);
    for (const property of properties) expect(alarm).toContain(property);
  });
});
