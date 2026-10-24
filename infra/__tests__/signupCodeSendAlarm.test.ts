// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSignupCodeSendAlarmThreshold } from '../signupAlarmThreshold';

const resources = vi.hoisted(() => {
  function output<T>(value: T) {
    return { value, apply: <Result>(callback: (input: T) => Result) => output(callback(value)) };
  }
  return {
    output,
    filter: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    alarm: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    logGroup: { name: 'server-logs' } as { name: string } | undefined,
    topic: { arn: 'alarm-topic' } as { arn: string } | undefined,
    hasServer: true,
  };
});

vi.mock('../web', () => ({
  web: {
    get nodes() {
      return {
        server: resources.hasServer ? resources.output({ nodes: { logGroup: resources.logGroup } }) : undefined,
      };
    },
  },
}));
vi.mock('../dlqAlarms', () => ({
  get dlqAlarmTopic() {
    return resources.topic;
  },
}));
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

async function loadAlarms(stage = 'production', appName = 'test-app') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: appName, stage });
  await import('../signupAlarms');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SIGNUP_CODE_SEND_ALARM_PER_HOUR', '12');
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubGlobal('aws', { cloudwatch: { LogMetricFilter: resources.filter, MetricAlarm: resources.alarm } });
  resources.logGroup = { name: 'server-logs' };
  resources.topic = { arn: 'alarm-topic' };
  resources.hasServer = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('parseSignupCodeSendAlarmThreshold', () => {
  it.each([undefined, '', '  '])('disables the alarm for %s', raw => {
    expect(parseSignupCodeSendAlarmThreshold(raw)).toBeUndefined();
  });
  it.each([
    ['12', 12],
    ['1', 1],
    [' 24 ', 24],
  ] as const)('accepts %s', (raw, expected) => {
    expect(parseSignupCodeSendAlarmThreshold(raw)).toBe(expected);
  });
  it.each(['0', '-3', '2.5', 'abc', 'Infinity', 'NaN'])('throws on %s', raw => {
    expect(() => parseSignupCodeSendAlarmThreshold(raw)).toThrow(/SIGNUP_CODE_SEND_ALARM_PER_HOUR/);
  });
});

describe('signup code send alarm wiring', () => {
  it('counts dispatch messages, excluding request timing and spoofed metadata', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledExactlyOnceWith('signupCodeSendsFilter', {
      name: 'test-app-production-signup-code-sends',
      logGroupName: expect.objectContaining({ value: 'server-logs' }),
      pattern: '%\\x22message\\x22:\\x22otc-code-dispatched\\x22%',
      metricTransformation: {
        name: 'SignupCodeSends',
        namespace: 'test-app/production/Signup',
        value: '1',
        unit: 'Count',
      },
    });
    const pattern = resources.filter.mock.calls[0][1].pattern;
    if (typeof pattern !== 'string') throw new Error('Missing metric filter pattern');
    const expression = new RegExp(pattern.slice(1, -1));
    const prefix = '2026-10-23T00:00:00.000Z request-id INFO ';
    expect(expression.test(prefix + JSON.stringify({ message: 'otc-code-dispatched' }))).toBe(true);
    expect(expression.test(prefix + JSON.stringify({ path: '/api/otc/send', message: 'req-timing' }))).toBe(false);
    expect(expression.test(prefix + JSON.stringify({ requestId: 'otc-code-dispatched', message: 'req-timing' }))).toBe(
      false
    );
    expect(
      expression.test(
        prefix + JSON.stringify({ path: '/api/otc/send?message="otc-code-dispatched"', message: 'req-timing' })
      )
    ).toBe(false);
  });

  it('alarms on the hourly sum and routes to the monitored topic', async () => {
    await loadAlarms();
    expect(resources.alarm).toHaveBeenCalledExactlyOnceWith('signupCodeSendRate', {
      name: 'test-app-production-signup-code-send-rate',
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SignupCodeSends',
      namespace: 'test-app/production/Signup',
      period: 3600,
      statistic: 'Sum',
      threshold: 12,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic'],
      tags: { Application: 'Signup', Severity: 'Medium' },
    });
  });

  it.each([
    ['dev', 'test-app'],
    ['production', 'test-app'],
    ['production', 'other-app'],
  ])('isolates the metric for stage %s and app %s', async (stage, appName) => {
    await loadAlarms(stage, appName);
    const namespace = `${appName}/${stage}/Signup`;
    expect(resources.filter.mock.calls[0][1].metricTransformation).toMatchObject({ namespace });
    expect(resources.alarm.mock.calls[0][1].namespace).toBe(namespace);
  });

  it.each([undefined, '', '  '])('creates no resources when the threshold is %s', async threshold => {
    vi.stubEnv('SIGNUP_CODE_SEND_ALARM_PER_HOUR', threshold);
    await loadAlarms();
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });
  it('creates no resources on an unmonitored stage', async () => {
    await loadAlarms('preview');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });
  it('allows a preview to opt in to monitoring', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    await loadAlarms('preview');
    expect(resources.alarm.mock.calls[0][1].namespace).toBe('test-app/preview/Signup');
  });
  it('rejects a malformed configured threshold', async () => {
    vi.stubEnv('SIGNUP_CODE_SEND_ALARM_PER_HOUR', 'oops');
    await expect(loadAlarms()).rejects.toThrow(/SIGNUP_CODE_SEND_ALARM_PER_HOUR/);
    expect(resources.alarm).not.toHaveBeenCalled();
  });
  it('fails loudly when alarm routing is missing', async () => {
    resources.topic = undefined;
    await expect(loadAlarms()).rejects.toThrow('alarm routing requires dlqAlarmTopic');
  });
  it('fails loudly when the server is missing', async () => {
    resources.hasServer = false;
    await expect(loadAlarms()).rejects.toThrow('requires the Next.js server function');
  });
  it('fails loudly when the server log group is missing', async () => {
    resources.logGroup = undefined;
    await expect(loadAlarms()).rejects.toThrow('missing its CloudWatch log group');
  });
  it('declares the env var in the deploy contract and exports the module', () => {
    const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8'));
    expect(contract.deployEnv).toContain('SIGNUP_CODE_SEND_ALARM_PER_HOUR');
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain("export * from './signupAlarms';");
  });
});
