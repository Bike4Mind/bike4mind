/**
 * @vitest-environment node
 *
 * Infra is an SST program and cannot load outside `sst`; the pure parser is
 * imported directly and the wiring is pinned from the source text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSignupCodeSendAlarmThreshold } from '../signupAlarmThreshold';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8');
const source = read('infra/signupAlarms.ts');
const filter = source.match(/new aws\.cloudwatch\.LogMetricFilter\([\s\S]*?\n {2}\}\);/)?.[0];
const alarm = source.match(/new aws\.cloudwatch\.MetricAlarm\([\s\S]*?\n {2}\}\);/)?.[0];

describe('parseSignupCodeSendAlarmThreshold', () => {
  it('treats unset and empty as no alarm', () => {
    expect(parseSignupCodeSendAlarmThreshold(undefined)).toBeUndefined();
    expect(parseSignupCodeSendAlarmThreshold('')).toBeUndefined();
    expect(parseSignupCodeSendAlarmThreshold('  ')).toBeUndefined();
  });

  it('accepts integers of at least 1', () => {
    expect(parseSignupCodeSendAlarmThreshold('12')).toBe(12);
    expect(parseSignupCodeSendAlarmThreshold('1')).toBe(1);
  });

  it.each(['0', '-3', '2.5', 'abc', 'Infinity', 'NaN'])('throws on %s', raw => {
    expect(() => parseSignupCodeSendAlarmThreshold(raw)).toThrow(/SIGNUP_CODE_SEND_ALARM_PER_HOUR/);
  });
});

describe('signup code send alarm wiring', () => {
  it('filters on the timing line for the send route in the Next.js server log group', () => {
    expect(filter).toBeDefined();
    expect(filter).toMatch(/pattern: '"req-timing" "\/api\/otc\/send"'/);
    expect(filter).toMatch(/logGroupName: serverLogGroupName/);
    expect(source).toMatch(/const serverLogGroupName = web\.nodes\.server/);
  });

  it('alarms hourly on the summed metric and routes to the monitored topic', () => {
    expect(alarm).toBeDefined();
    expect(alarm).toMatch(/period: 3600/);
    expect(alarm).toMatch(/statistic: 'Sum'/);
    expect(alarm).toMatch(/comparisonOperator: 'GreaterThanOrEqualToThreshold'/);
    expect(alarm).toMatch(/treatMissingData: 'notBreaching'/);
    expect(alarm).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
    expect(alarm).toMatch(/threshold,/);
  });

  it('creates resources only on a monitored stage with a configured threshold', () => {
    expect(source).toMatch(/if \(isMonitoredStage && threshold !== undefined\) \{/);
    expect(source).toMatch(/process\.env\.SIGNUP_CODE_SEND_ALARM_PER_HOUR/);
  });

  it('declares the env var in the deploy contract and exports the module', () => {
    expect(JSON.parse(read('infra/deploy-contract.json')).deployEnv).toContain('SIGNUP_CODE_SEND_ALARM_PER_HOUR');
    expect(read('infra/index.ts')).toMatch(/export \* from '\.\/signupAlarms';/);
  });
});
