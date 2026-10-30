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
import { oauthSignupsRefusedMetricName } from '../authAbuseMetric';
import { messageFilterPattern } from '../logMessageFilterPattern';
import { matchesMessageFilterPattern } from './helpers/matchesMessageFilterPattern';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
const ALARMS = read('infra/authAbuseAlarms.ts');

describe('oauth signups refused alarm', () => {
  it('filters the exact message the callback logs at info level', () => {
    expect(read('apps/client/pages/api/auth/[strategy]/callback.ts')).toContain(
      "req.logger?.info('oauth-signup-refused')"
    );
    expect(ALARMS).toContain("pattern: messageFilterPattern('oauth-signup-refused')");
    const pattern = messageFilterPattern('oauth-signup-refused');
    const matches = (line: string) => matchesMessageFilterPattern(pattern, line);
    const line = (fields: Record<string, string>) =>
      `2026-01-01T00:00:00.000Z\tc0ffee\tINFO\t${JSON.stringify({ severity: 'info', message: 'oauth-ip-rate-limited', ...fields })}`;

    expect(matches(line({ message: 'oauth-signup-refused', requestId: 'abc' }))).toBe(true);
    // A caller controls X-Request-ID (sanitized to [A-Za-z0-9._-]) and the URL, not the message.
    expect(matches(line({ requestId: 'oauth-signup-refused' }))).toBe(false);
    expect(matches(line({ path: '/api/auth/google?x=oauth-signup-refused' }))).toBe(false);
    expect(matches(line({ path: '/x?"message":"oauth-signup-refused"' }))).toBe(false);
  });

  it('feeds Lumina5/AuthSecurity OAuthSignupsRefused, summed over 5 minutes', () => {
    expect(ALARMS).toMatch(/NAMESPACE = 'Lumina5\/AuthSecurity'/);
    expect(ALARMS).toContain('const METRIC_NAME = oauthSignupsRefusedMetricName($app.stage);');
    expect(ALARMS).toMatch(
      /metricName: METRIC_NAME,\s*namespace: NAMESPACE,\s*period: 300,[^\n]*\n\s*statistic: 'Sum'/
    );
    expect(ALARMS).toMatch(/treatMissingData: 'notBreaching'/);
  });

  it('isolates monitored stages sharing an account without resetting production history', () => {
    expect(oauthSignupsRefusedMetricName('production')).toBe('OAuthSignupsRefused');
    const names = ['production', 'dev', 'pr123', 'pr456'].map(oauthSignupsRefusedMetricName);
    expect(new Set(names).size).toBe(names.length);
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
