/**
 * @vitest-environment node
 *
 * Pins the refused-sign-up alarm to the log line the callback writes. With treatMissingData
 * 'notBreaching', a drifted literal leaves the alarm OK forever and every other suite green.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
const ALARMS = read('infra/authAbuseAlarms.ts');

describe('oauth signups refused alarm', () => {
  it('filters the exact message the callback logs at info level', () => {
    expect(read('apps/client/pages/api/auth/[strategy]/callback.ts')).toContain(
      "req.logger?.info('oauth-signup-refused')"
    );
    expect(ALARMS).toContain(`pattern: '{ $.message = "oauth-signup-refused" }'`);
  });

  it('feeds Lumina5/AuthSecurity OAuthSignupsRefused, summed over 5 minutes', () => {
    expect(ALARMS).toMatch(/NAMESPACE = 'Lumina5\/AuthSecurity'/);
    expect(ALARMS).toMatch(/METRIC_NAME = 'OAuthSignupsRefused'/);
    expect(ALARMS).toMatch(/metricName: METRIC_NAME,\s*namespace: NAMESPACE,\s*period: 300,[^\n]*\n\s*statistic: 'Sum'/);
    expect(ALARMS).toMatch(/treatMissingData: 'notBreaching'/);
  });

  it('routes alarm and recovery to the DLQ alarm topic', () => {
    expect(ALARMS).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
    expect(ALARMS).toMatch(/okActions: \[dlqAlarmTopic\.arn\]/);
  });

  it('reads a 25-per-5-minute default threshold from a declared deploy variable', () => {
    expect(ALARMS).toMatch(/DEFAULT_THRESHOLD_PER_5MIN = 25/);
    expect(ALARMS).toContain('process.env.OAUTH_SIGNUP_REFUSED_ALARM_PER_5MIN');
    expect(JSON.parse(read('infra/deploy-contract.json')).deployEnv).toContain('OAUTH_SIGNUP_REFUSED_ALARM_PER_5MIN');
  });

  it('is exported before logMonitor', () => {
    const index = read('infra/index.ts');
    expect(index.indexOf("'./authAbuseAlarms'")).toBeGreaterThan(-1);
    expect(index.indexOf("'./authAbuseAlarms'")).toBeLessThan(index.indexOf("'./logMonitor'"));
  });
});
