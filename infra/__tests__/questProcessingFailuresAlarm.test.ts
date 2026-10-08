/**
 * @vitest-environment node
 *
 * Pins the quest-processing-failures alarm to the series the emitter writes for /process. With
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
const EMITTER_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'apps/client/server/chatCompletion/processingFailedMetric.ts'),
  'utf8'
);
const ROUTE_SOURCE = readFileSync(path.join(REPO_ROOT, 'apps/client/server/chatCompletion/internal/route.ts'), 'utf8');

const alarm = ALARMS_SOURCE.match(
  /new aws\.cloudwatch\.MetricAlarm\('questProcessingFailures', \{[\s\S]*?\n {2}\}\);/
)?.[0];

describe('questProcessingFailures alarm', () => {
  it('is found in infra/alarms.ts', () => {
    expect(alarm).toBeDefined();
  });

  it('watches the ProcessingFailed series the emitter writes for /process', () => {
    expect(alarm).toMatch(/metricName: QUEST_METRICS\.ProcessingFailed/);
    expect(alarm).toMatch(/namespace: QUESTS_NAMESPACE/);
    expect(alarm).toMatch(/dimensions: \{ Stage: \$app\.stage, Surface: '\/process' \}/);

    expect(EMITTER_SOURCE).toMatch(/emitMetrics\(QUESTS_NAMESPACE/);
    expect(EMITTER_SOURCE).toMatch(/name: QUEST_METRICS\.ProcessingFailed/);
    expect(EMITTER_SOURCE).toMatch(/datum\(\{ Stage: stage, Surface: surface \}\)/);
  });

  it('is fed the literal Surface value by the /process route', () => {
    expect(ROUTE_SOURCE).toMatch(/emitProcessingFailed\('\/process'/);
  });
});
