/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALARMS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/alarms.ts'), 'utf8');
const alarmSource = (id: string) =>
  ALARMS_SOURCE.match(new RegExp(`new aws\\.cloudwatch\\.MetricAlarm\\('${id}', \\{[\\s\\S]*?\\n {4}\\}\\);`))?.[0];
const alarm = alarmSource('spendMonitorHeartbeat');
const errorsAlarm = alarmSource('spendMonitorLambdaErrors');

describe('spendMonitorHeartbeat alarm', () => {
  it('is defined in infra/alarms.ts', () => {
    expect(alarm).toBeDefined();
  });

  it('breaches on fewer than 1 invocation over three 5-minute periods, counting silence as breaching', () => {
    expect(alarm).toMatch(/comparisonOperator: 'LessThanThreshold'/);
    expect(alarm).toMatch(/metricName: 'Invocations'/);
    expect(alarm).toMatch(/evaluationPeriods: 3/);
    expect(alarm).toMatch(/period: 300/);
    expect(alarm).toMatch(/statistic: 'Sum'/);
    expect(alarm).toMatch(/threshold: 1,/);
    expect(alarm).toMatch(/treatMissingData: 'breaching'/);
  });

  it('watches the spendMonitor cron function and pages the DLQ alarm topic', () => {
    expect(alarm).toMatch(/FunctionName: spendMonitor\.nodes\.function\.name/);
    expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
  });
});

describe('spendMonitorLambdaErrors alarm', () => {
  it('is defined in infra/alarms.ts', () => {
    expect(errorsAlarm).toBeDefined();
  });

  it('breaches on at least 1 error in 2 of three 5-minute periods, counting silence as healthy', () => {
    expect(errorsAlarm).toMatch(/comparisonOperator: 'GreaterThanOrEqualToThreshold'/);
    expect(errorsAlarm).toMatch(/metricName: 'Errors'/);
    expect(errorsAlarm).toMatch(/namespace: 'AWS\/Lambda'/);
    expect(errorsAlarm).toMatch(/evaluationPeriods: 3/);
    expect(errorsAlarm).not.toMatch(/datapointsToAlarm/);
    expect(errorsAlarm).toMatch(/period: 300/);
    expect(errorsAlarm).toMatch(/statistic: 'Sum'/);
    expect(errorsAlarm).toMatch(/threshold: 1,/);
    expect(errorsAlarm).toMatch(/treatMissingData: 'notBreaching'/);
  });

  it('watches the spendMonitor cron function and pages the DLQ alarm topic', () => {
    expect(errorsAlarm).toMatch(/FunctionName: spendMonitor\.nodes\.function\.name/);
    expect(errorsAlarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
  });
});
