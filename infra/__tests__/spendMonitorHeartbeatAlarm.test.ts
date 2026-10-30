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
const alarm = ALARMS_SOURCE.match(
  /new aws\.cloudwatch\.MetricAlarm\('spendMonitorHeartbeat', \{[\s\S]*?\n {4}\}\);/
)?.[0];

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
