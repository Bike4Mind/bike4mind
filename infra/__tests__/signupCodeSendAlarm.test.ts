// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchesMessageFilterPattern } from './helpers/matchesMessageFilterPattern';
import { parseAlarmThreshold, parseSignupCodeSendAlarmThreshold } from '../signupAlarmThreshold';

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

function callFor(mock: typeof resources.filter, name: string): Record<string, unknown> | undefined {
  return mock.mock.calls.find(([logicalName]) => logicalName === name)?.[1];
}
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
  vi.stubEnv('SIGNUP_GRANT_REVIEW_ALARM_PER_5MIN', undefined);
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

describe('parseAlarmThreshold', () => {
  it('falls back to the default when blank', () => {
    expect(parseAlarmThreshold('X', undefined, 15)).toBe(15);
    expect(parseAlarmThreshold('X', '  ', 15)).toBe(15);
  });
  it('names the variable in the error', () => {
    expect(() => parseAlarmThreshold('SOME_VAR', '1.5', 15)).toThrow(/SOME_VAR/);
  });
});

describe('signup code send alarm wiring', () => {
  it('counts each committed grant band and routes a configured review spike to both alarm channels', async () => {
    vi.stubEnv('SIGNUP_GRANT_REVIEW_ALARM_PER_5MIN', '7');
    await loadAlarms();
    for (const band of ['full', 'reduced', 'review']) {
      expect(callFor(resources.filter, `signupGrant${band}Filter`)).toMatchObject({
        pattern: `{ $.message = "signup-grant-assessed-${band}" }`,
        metricTransformation: { name: `SignupGrant_${band}`, namespace: 'test-app/production/Signup', value: '1' },
      });
    }
    expect(callFor(resources.alarm, 'signupGrantReviewBurst')).toMatchObject({
      metricName: 'SignupGrant_review',
      threshold: 7,
      period: 300,
      alarmActions: ['alarm-topic'],
      okActions: ['alarm-topic'],
    });
  });

  it('leaves the review alarm off without private configuration', async () => {
    await loadAlarms();
    expect(callFor(resources.alarm, 'signupGrantReviewBurst')).toBeUndefined();
  });
  it('counts dispatch messages, excluding request timing and spoofed metadata', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledWith('signupCodeSendsFilter', {
      name: 'test-app-production-signup-code-sends',
      logGroupName: expect.objectContaining({ value: 'server-logs' }),
      pattern: '{ $.message = "otc-code-dispatched" }',
      metricTransformation: {
        name: 'SignupCodeSends',
        namespace: 'test-app/production/Signup',
        value: '1',
        unit: 'Count',
      },
    });
    const pattern = callFor(resources.filter, 'signupCodeSendsFilter')?.pattern;
    if (typeof pattern !== 'string') throw new Error('Missing metric filter pattern');
    const expression = { test: (line: string) => matchesMessageFilterPattern(pattern, line) };
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

  it('alarms on the hourly sum and routes ALARM and OK to Slack and email', async () => {
    await loadAlarms();
    expect(resources.alarm).toHaveBeenCalledWith('signupCodeSendRate', {
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
      okActions: ['alarm-topic'],
      tags: { Application: 'Signup', Severity: 'Medium' },
    });
  });

  it('alarms on 5-minute bursts of code sends with the default ceiling', async () => {
    await loadAlarms();
    expect(resources.alarm).toHaveBeenCalledWith('signupCodeSendBurst', {
      name: 'test-app-production-signup-code-send-burst',
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'SignupCodeSends',
      namespace: 'test-app/production/Signup',
      period: 300,
      statistic: 'Sum',
      threshold: 15,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic'],
      okActions: ['alarm-topic'],
      tags: { Application: 'Signup', Severity: 'High' },
    });
  });

  it('counts API key creations and alarms on 5-minute bursts', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledWith('apiKeyCreationsFilter', {
      name: 'test-app-production-api-key-creations',
      logGroupName: expect.objectContaining({ value: 'server-logs' }),
      pattern: '{ $.message = "user-api-key-created" }',
      metricTransformation: {
        name: 'ApiKeyCreations',
        namespace: 'test-app/production/Signup',
        value: '1',
        unit: 'Count',
      },
    });
    expect(callFor(resources.alarm, 'apiKeyCreateBurst')).toMatchObject({
      metricName: 'ApiKeyCreations',
      namespace: 'test-app/production/Signup',
      period: 300,
      statistic: 'Sum',
      threshold: 10,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      alarmActions: ['alarm-topic'],
      okActions: ['alarm-topic'],
    });
    const pattern = callFor(resources.filter, 'apiKeyCreationsFilter')?.pattern;
    if (typeof pattern !== 'string') throw new Error('Missing metric filter pattern');
    const expression = { test: (line: string) => matchesMessageFilterPattern(pattern, line) };
    const prefix = '2026-10-23T00:00:00.000Z request-id INFO ';
    expect(expression.test(prefix + JSON.stringify({ message: 'user-api-key-created' }))).toBe(true);
    expect(expression.test(prefix + JSON.stringify({ name: 'user-api-key-created', message: 'req-timing' }))).toBe(
      false
    );
  });

  it('reads configured burst ceilings', async () => {
    vi.stubEnv('SIGNUP_CODE_SEND_ALARM_PER_5MIN', '40');
    vi.stubEnv('API_KEY_CREATE_ALARM_PER_5MIN', '3');
    await loadAlarms();
    expect(callFor(resources.alarm, 'signupCodeSendBurst')?.threshold).toBe(40);
    expect(callFor(resources.alarm, 'apiKeyCreateBurst')?.threshold).toBe(3);
  });

  it.each(['SIGNUP_CODE_SEND_ALARM_PER_5MIN', 'API_KEY_CREATE_ALARM_PER_5MIN'])(
    'rejects a malformed %s',
    async name => {
      vi.stubEnv(name, '0');
      await expect(loadAlarms()).rejects.toThrow(new RegExp(name));
    }
  );

  it.each([
    ['dev', 'test-app'],
    ['production', 'test-app'],
    ['production', 'other-app'],
  ])('isolates the metric for stage %s and app %s', async (stage, appName) => {
    await loadAlarms(stage, appName);
    const namespace = `${appName}/${stage}/Signup`;
    for (const [, args] of resources.filter.mock.calls) {
      expect(args.metricTransformation).toMatchObject({ namespace });
    }
    for (const [, args] of resources.alarm.mock.calls) {
      expect(args.namespace).toBe(namespace);
    }
  });

  it.each([undefined, '', '  '])('creates no hourly alarm when the threshold is %s', async threshold => {
    vi.stubEnv('SIGNUP_CODE_SEND_ALARM_PER_HOUR', threshold);
    await loadAlarms();
    expect(callFor(resources.filter, 'signupCodeSendsFilter')).toBeDefined();
    expect(resources.alarm.mock.calls.map(([name]) => name)).toEqual(['signupCodeSendBurst', 'apiKeyCreateBurst']);
  });
  it('creates no resources on an unmonitored stage', async () => {
    await loadAlarms('preview');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });
  it('allows a preview to opt in to monitoring', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    await loadAlarms('preview');
    expect(callFor(resources.alarm, 'signupCodeSendBurst')?.namespace).toBe('test-app/preview/Signup');
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
    for (const name of [
      'SIGNUP_CODE_SEND_ALARM_PER_HOUR',
      'SIGNUP_CODE_SEND_ALARM_PER_5MIN',
      'API_KEY_CREATE_ALARM_PER_5MIN',
      'SIGNUP_EDGE_SIGNAL_ALARM_PER_5MIN',
      'YOUNG_ACCOUNT_SPEND_ALERT_CREDITS',
      'YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS',
    ]) {
      expect(contract.deployEnv).toContain(name);
    }
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain("export * from './signupAlarms';");
  });
});
