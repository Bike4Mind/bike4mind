/**
 * @vitest-environment node
 *
 * Pins the stale voice hold alarms to the series the sweep handler emits. With treatMissingData
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
const EMITTER_SOURCE = readFileSync(path.join(REPO_ROOT, 'apps/workers/src/cron/voiceHoldSweep.ts'), 'utf8');

/** Each alarm's SST id and the VOICE_METRICS key it must watch. */
const ALARMS = [
  { id: 'voiceStaleHoldsSettled', metric: 'HoldSweepSettled' },
  { id: 'voiceHoldSweepFailures', metric: 'HoldSweepFailed' },
] as const;

function alarmBlock(id: string): string | undefined {
  return ALARMS_SOURCE.match(
    new RegExp(`new aws\\.cloudwatch\\.MetricAlarm\\('${id}', \\{[\\s\\S]*?\\n {2}\\}\\);`)
  )?.[0];
}

describe('stale voice hold sweep alarms', () => {
  it('the handler emits every series in the voice namespace, dimensioned by Stage only', () => {
    expect(EMITTER_SOURCE).toMatch(/emitMetrics\(VOICE_NAMESPACE,/);
    for (const { metric } of ALARMS) {
      expect(EMITTER_SOURCE).toMatch(
        new RegExp(`name: VOICE_METRICS\\.${metric},\\s*value: [^,]+,\\s*dimensions: \\{ Stage: stage \\}`)
      );
    }
  });

  for (const { id, metric } of ALARMS) {
    describe(id, () => {
      const alarm = alarmBlock(id);

      it('is found in infra/alarms.ts', () => {
        expect(alarm).toBeDefined();
      });

      it('watches the Stage-dimensioned sweep series the handler writes', () => {
        expect(alarm).toMatch(new RegExp(`metricName: VOICE_METRICS\\.${metric}\\b`));
        expect(alarm).toMatch(/namespace: VOICE_NAMESPACE/);
        // CloudWatch alarms match one exact dimension set, and the handler emits { Stage } only.
        expect(alarm).toMatch(/dimensions: \{ Stage: \$app\.stage \}/);
      });

      it('pages the DLQ alarm topic', () => {
        expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
      });
    });
  }
});
