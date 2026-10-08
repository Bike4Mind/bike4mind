/**
 * @vitest-environment node
 *
 * The no-successful-run alarm breaches on missing data, so it must exist only where the discovery
 * cron runs; created on a monitored preview it would sit in ALARM forever.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALARMS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/alarms.ts'), 'utf8');
const CRON_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/cron.ts'), 'utf8');

const gatedAlarm = ALARMS_SOURCE.match(
  /if \(modelDiscoveryCronEnabled\) \{\s*new aws\.cloudwatch\.MetricAlarm\('modelDiscoveryNoSuccessfulRun', \{[\s\S]*?\n {4}\}\);\n {2}\}/
)?.[0];

describe('modelDiscoveryNoSuccessfulRun alarm', () => {
  it('is created only behind the cron enable flag', () => {
    expect(gatedAlarm).toBeDefined();
  });

  it('breaches on a missing RunFailures datum and on a 24h Minimum of 1', () => {
    expect(gatedAlarm).toMatch(/metricName: 'RunFailures'/);
    expect(gatedAlarm).toMatch(/statistic: 'Minimum'/);
    expect(gatedAlarm).toMatch(/period: 86400/);
    expect(gatedAlarm).toMatch(/treatMissingData: 'breaching'/);
    expect(gatedAlarm).toMatch(/dimensions: modelDiscoveryDimensions/);
  });

  it('shares the flag with the cron it watches', () => {
    expect(CRON_SOURCE).toMatch(/enabled: modelDiscoveryCronEnabled,/);
  });
});
