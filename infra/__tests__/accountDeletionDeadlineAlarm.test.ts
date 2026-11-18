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
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const ALARMS_SOURCE = read('infra/alarms.ts');
const alarm = ALARMS_SOURCE.match(
  /new aws\.cloudwatch\.MetricAlarm\('accountDeletionDeadline', \{[\s\S]*?\n {4}\}\);/
)?.[0];

const sweepCron = read('infra/cron.ts').match(
  /new sst\.aws\.Cron\('accountDeletionSweep', \{[\s\S]*?transform: accountDeletionSweepDeadLetter\.functionTarget/
)?.[0];

describe('accountDeletionDeadline alarm', () => {
  // Without the grant every PutMetricData is denied and swallowed, so the alarm never gets a
  // datapoint and sits in ALARM instead of paging on a real overdue request.
  it('lets the sweep publish the metric the alarm reads', () => {
    expect(sweepCron).toBeDefined();
    expect(sweepCron).toMatch(/actions:\s*\['cloudwatch:PutMetricData'\]/);
  });

  it('is defined in infra/alarms.ts, only where the sweep cron exists', () => {
    expect(alarm).toBeDefined();
    expect(ALARMS_SOURCE).toMatch(
      /if \(accountDeletionSweep\) \{\s+new aws\.cloudwatch\.MetricAlarm\('accountDeletionDeadline'/
    );
  });

  it('cannot be cleared by missing data: a window with no datapoint reads as 1 and as breaching', () => {
    expect(alarm).toMatch(/expression: 'FILL\(m, 1\)'/);
    expect(alarm).toMatch(/treatMissingData: 'breaching'/);
    expect(alarm).toMatch(/comparisonOperator: 'GreaterThanThreshold'/);
    expect(alarm).toMatch(/threshold: 0,/);
    expect(alarm).toMatch(/evaluationPeriods: 1,/);
    expect(alarm).not.toMatch(/datapointsToAlarm/);
  });

  it('reads the metric the sweep emits, Stage dimension only, over a 2-day period', () => {
    expect(alarm).toMatch(/metricName: 'OverdueDeletionRequests'/);
    expect(alarm).toMatch(/namespace: 'Lumina5\/AccountDeletion'/);
    expect(alarm).toMatch(/period: 172800/);
    expect(alarm).toMatch(/stat: 'Maximum'/);
    expect(alarm).toMatch(/dimensions: \{ Stage: \$app\.stage \}/);
  });

  it('pages the DLQ alarm topic', () => {
    expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
  });

  it('matches the namespace and metric name the sweep emits', () => {
    const sweep = read('apps/workers/src/cron/accountDeletionSweep.ts');
    expect(sweep).toContain("'Lumina5/AccountDeletion'");
    expect(sweep).toContain("'OverdueDeletionRequests'");
  });

  it('has a runbook', () => {
    expect(read('infra/account-deletion-deadline-alarm.md')).toContain('OverdueDeletionRequests');
  });
});
