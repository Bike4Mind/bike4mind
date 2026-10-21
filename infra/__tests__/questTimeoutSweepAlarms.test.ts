/**
 * @vitest-environment node
 *
 * Pins the quest callback-sweep alarms to the series the timeout sweep emits. With treatMissingData
 * 'notBreaching', a drifted literal leaves the alarm OK forever and every other suite green.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALARMS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/alarms.ts'), 'utf8');
const EMITTER_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'apps/workers/src/cron/questTimeoutSweep.ts'),
  'utf8'
);

/** Each alarm's SST id and the QUEST_METRICS key it must watch. */
const ALARMS = [
  { id: 'questCallbackLimitReached', metric: 'TimeoutSweepCallbacksFailedLimitReached' },
  { id: 'questCallbackHorizonPassed', metric: 'TimeoutSweepCallbacksFailedHorizonPassed' },
  { id: 'questStaleCallbackReenqueued', metric: 'TimeoutSweepStaleCallbacksReenqueued' },
] as const;

function alarmBlock(id: string): string | undefined {
  return ALARMS_SOURCE.match(
    new RegExp(`new aws\\.cloudwatch\\.MetricAlarm\\('${id}', \\{[\\s\\S]*?\\n {2}\\}\\);`)
  )?.[0];
}

describe('quest callback-sweep alarms', () => {
  for (const { id, metric } of ALARMS) {
    describe(id, () => {
      const alarm = alarmBlock(id);

      it('is found in infra/alarms.ts', () => {
        expect(alarm).toBeDefined();
      });

      it('watches the Stage-dimensioned sweep series the emitter writes', () => {
        expect(alarm).toMatch(new RegExp(`metricName: QUEST_METRICS\\.${metric}\\b`));
        expect(alarm).toMatch(/namespace: QUESTS_NAMESPACE/);
        // CloudWatch alarms match one exact dimension set, and the sweep emits { Stage } only.
        expect(alarm).toMatch(/dimensions: \{ Stage: \$app\.stage \}/);

        expect(EMITTER_SOURCE).toMatch(new RegExp(`QUEST_METRICS\\.${metric}\\b`));
      });

      it('pages the DLQ alarm topic', () => {
        expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
      });
    });
  }
});
