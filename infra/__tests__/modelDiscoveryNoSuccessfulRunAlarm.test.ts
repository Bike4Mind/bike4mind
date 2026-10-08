/**
 * @vitest-environment node
 *
 * Infra is an SST program and cannot load outside `sst`; pin the wiring to
 * the independently scheduled check whose behavior is exercised in workers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const alarmsSource = readFileSync(path.join(repoRoot, 'infra/alarms.ts'), 'utf8');
const cronSource = readFileSync(path.join(repoRoot, 'infra/cron.ts'), 'utf8');
const checkerSource = readFileSync(path.join(repoRoot, 'apps/workers/src/cron/modelDiscoveryStaleness.ts'), 'utf8');

const alarm = alarmsSource.match(
  /new aws\.cloudwatch\.MetricAlarm\('modelDiscoveryNoSuccessfulRun', \{[\s\S]*?\n {4}\}\);/
)?.[0];
const stalenessCron = cronSource.match(/new sst\.aws\.Cron\('modelDiscoveryStalenessCron', \{[\s\S]*?\n\}\);/)?.[0];
const discoveryCron = cronSource.match(/new sst\.aws\.Cron\('modelDiscoveryCron', \{[\s\S]*?\n\}\);/)?.[0];
const checkerErrorAlarm = alarmsSource.match(
  /new aws\.cloudwatch\.MetricAlarm\('modelDiscoveryStalenessCheckErrors', \{[\s\S]*?\n {4}\}\);/
)?.[0];

describe('model discovery no-successful-run alarm', () => {
  it('runs the staleness check independently wherever discovery runs', () => {
    expect(discoveryCron).toMatch(/enabled: modelDiscoveryCronEnabled/);
    expect(stalenessCron).toMatch(/schedule: 'rate\(15 minutes\)'/);
    expect(stalenessCron).toMatch(/job: modelDiscoveryStalenessFunction\.arn/);
    expect(stalenessCron).toMatch(/enabled: modelDiscoveryCronEnabled/);
    expect(alarmsSource).toMatch(
      /if \(modelDiscoveryCronEnabled\) \{\s*new aws\.cloudwatch\.MetricAlarm\('modelDiscoveryNoSuccessfulRun'/
    );
  });

  it('alarms on a stale check, missing check, and routes to the monitored topic', () => {
    expect(alarm).toMatch(/metricName: 'NoSuccessfulRun'/);
    expect(alarm).toMatch(/namespace: 'Lumina5\/ModelDiscovery'/);
    expect(alarm).toMatch(/comparisonOperator: 'GreaterThanThreshold'/);
    expect(alarm).toMatch(/evaluationPeriods: 1/);
    expect(alarm).toMatch(/period: 1800/);
    expect(alarm).toMatch(/statistic: 'Maximum'/);
    expect(alarm).toMatch(/threshold: 0/);
    expect(alarm).toMatch(/treatMissingData: 'breaching'/);
    expect(alarm).toMatch(/dimensions: modelDiscoveryDimensions/);
    expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
    expect(checkerSource).toMatch(/Namespace: 'Lumina5\/ModelDiscovery'/);
    expect(checkerSource).toMatch(/MetricName: 'NoSuccessfulRun'/);
    expect(checkerSource).toMatch(/\{ Name: 'Stage', Value: stage \}/);
    expect(checkerSource).toMatch(/\{ Name: 'Host', Value: 'hosted' \}/);
  });

  it('alarms when the staleness checker itself fails', () => {
    expect(checkerErrorAlarm).toMatch(/FunctionName: modelDiscoveryStalenessFunction\.name/);
    expect(checkerErrorAlarm).toMatch(/metricName: 'Errors'/);
    expect(checkerErrorAlarm).toMatch(/namespace: 'AWS\/Lambda'/);
    expect(checkerErrorAlarm).toMatch(/threshold: 0/);
    expect(checkerErrorAlarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
  });
});
