/**
 * @vitest-environment node
 *
 * Pins the billing-event ingest alarm to the series emitActiveEvent.ts writes. With
 * treatMissingData 'notBreaching', a drifted literal leaves the alarm OK forever and every other
 * suite green.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALARMS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/alarms.ts'), 'utf8');
const EMITTER_SOURCE = readFileSync(path.join(REPO_ROOT, 'apps/client/server/analytics/emitActiveEvent.ts'), 'utf8');

const alarm = ALARMS_SOURCE.match(
  /new aws\.cloudwatch\.MetricAlarm\('billingEventIngestFailures', \{[\s\S]*?\n {2}\}\);/
)?.[0];

describe('billingEventIngestFailures alarm', () => {
  it('is found in infra/alarms.ts', () => {
    expect(alarm).toBeDefined();
  });

  it('watches the series the emitter writes, under the same Stage dimension', () => {
    expect(alarm).toMatch(/metricName: 'IngestEmitFailed'/);
    expect(alarm).toMatch(/namespace: 'Lumina5\/Analytics'/);
    expect(alarm).toMatch(/dimensions: \{ Stage: \$app\.stage \}/);
    expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);

    expect(EMITTER_SOURCE).toMatch(/namespace: 'Lumina5\/Analytics', name: 'IngestEmitFailed'/);
    expect(EMITTER_SOURCE).toMatch(/INGEST_FAILURE_METRIC\.name, 1, \{ Stage: Config\.STAGE \}/);
  });
});
