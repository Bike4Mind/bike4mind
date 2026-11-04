/**
 * @vitest-environment node
 *
 * Pins the image moderation review alarms to the series the sweep handler emits. With
 * treatMissingData 'notBreaching', a drifted literal leaves the alarm OK forever and every other
 * suite green.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PENDING_INCIDENT_ALARM_MINUTES, UNALERTED_INCIDENT_ALARM_MINUTES } from '@bike4mind/infra';
import { ALARM_CATALOG } from '../../apps/workers/src/events/alarmSlackMessage';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const ALARMS_SOURCE = read('infra/imageModerationReviewAlarms.ts');
const EMITTER_SOURCE = read('apps/workers/src/cron/imageModerationReviewSweep.ts');
const INDEX_SOURCE = read('infra/index.ts');

/** Each alarm's SST id, CloudWatch name suffix (the Slack catalog key), series and threshold. */
const ALARMS = [
  {
    id: 'imageModerationIncidentUnalerted',
    suffix: 'image-moderation-incident-unalerted',
    metric: 'OldestUnalertedAgeMinutes',
    threshold: 'UNALERTED_INCIDENT_ALARM_MINUTES',
    description: /over 30 minutes/,
  },
  {
    id: 'imageModerationIncidentUnreviewed',
    suffix: 'image-moderation-incident-unreviewed',
    metric: 'OldestPendingAgeMinutes',
    threshold: 'PENDING_INCIDENT_ALARM_MINUTES',
    description: /over 24 hours/,
  },
  {
    id: 'imageModerationNoReviewers',
    suffix: 'image-moderation-no-reviewers',
    metric: 'PendingWithoutReviewers',
    threshold: '0',
    description: /no reviewer address is configured/,
  },
] as const;

function alarmBlock(id: string): string | undefined {
  return ALARMS_SOURCE.match(
    new RegExp(`new aws\\.cloudwatch\\.MetricAlarm\\('${id}', \\{[\\s\\S]*?\\n {2}\\}\\);`)
  )?.[0];
}

describe('image moderation review alarms', () => {
  it('are loaded with the other alarms and only where the sweep exists', () => {
    expect(INDEX_SOURCE).toContain("export * from './imageModerationReviewAlarms';");
    expect(ALARMS_SOURCE).toMatch(/isMonitoredStage && imageModerationReviewSweepDeadLetter/);
  });

  it('keeps the 30 minute and 24 hour thresholds the descriptions state', () => {
    expect(UNALERTED_INCIDENT_ALARM_MINUTES).toBe(30);
    expect(PENDING_INCIDENT_ALARM_MINUTES).toBe(24 * 60);
  });

  for (const { id, suffix, metric, threshold, description } of ALARMS) {
    describe(id, () => {
      const alarm = alarmBlock(id);

      it('is found in infra/imageModerationReviewAlarms.ts', () => {
        expect(alarm).toBeDefined();
      });

      it('watches the Stage-dimensioned series the sweep handler writes', () => {
        expect(alarm).toMatch(new RegExp(`metricName: IMAGE_MODERATION_REVIEW_METRICS\\.${metric}\\b`));
        expect(alarm).toMatch(/namespace: IMAGE_MODERATION_REVIEW_NAMESPACE/);
        // CloudWatch alarms match one exact dimension set, and the handler emits { Stage } only.
        expect(alarm).toMatch(/dimensions: \{ Stage: \$app\.stage \}/);

        expect(EMITTER_SOURCE).toMatch(new RegExp(`IMAGE_MODERATION_REVIEW_METRICS\\.${metric}\\b`));
        expect(EMITTER_SOURCE).toMatch(/dimensions: \{ Stage: stage \}/);
        expect(EMITTER_SOURCE).toMatch(/emitMetrics\(IMAGE_MODERATION_REVIEW_NAMESPACE,/);
      });

      it('takes one sweep period at the maximum, stays OK when no run reports, and is plain English', () => {
        expect(alarm).toMatch(/comparisonOperator: 'GreaterThanThreshold'/);
        expect(alarm).toMatch(/statistic: 'Maximum'/);
        expect(alarm).toMatch(/period: REVIEW_SWEEP_INTERVAL_MINUTES \* 60,/);
        expect(alarm).toMatch(/evaluationPeriods: 1,/);
        expect(alarm).toMatch(new RegExp(`threshold: ${threshold},`));
        expect(alarm).toMatch(/treatMissingData: 'notBreaching'/);
        expect(alarm).toMatch(description);
      });

      it('pages the DLQ alarm topic and announces recovery', () => {
        expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
        expect(alarm).toMatch(/okActions: \[dlqAlarmTopic\.arn\]/);
      });

      it('is named so the Slack relay finds its plain-English entry', () => {
        expect(alarm).toContain(`-image-moderation-${suffix.replace('image-moderation-', '')}`);
        expect(ALARM_CATALOG[suffix]).toBeDefined();
      });
    });
  }
});
