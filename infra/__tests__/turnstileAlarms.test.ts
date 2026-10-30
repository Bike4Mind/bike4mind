// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { matchesMessageFilterPattern } from './helpers/matchesMessageFilterPattern';

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
    oobTopic: { arn: 'email-topic' } as { arn: string } | undefined,
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
  get oobAlarmTopic() {
    return resources.oobTopic;
  },
}));
vi.mock('../cardVerificationRecovery', () => ({ cardVerificationRecoveryLogGroup: 'recovery-logs' }));
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

async function loadAlarms(stage = 'production', appName = 'test-app') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: appName, stage });
  await import('../turnstileAlarms');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubGlobal('aws', { cloudwatch: { LogMetricFilter: resources.filter, MetricAlarm: resources.alarm } });
  resources.logGroup = { name: 'server-logs' };
  resources.topic = { arn: 'alarm-topic' };
  resources.oobTopic = { arn: 'email-topic' };
  resources.hasServer = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('turnstile policy alarm wiring', () => {
  it('counts the inactive-policy message, excluding other fields', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledWith('turnstilePolicyInactiveFilter', {
      name: 'test-app-production-turnstile-policy-inactive',
      logGroupName: expect.objectContaining({ value: 'server-logs' }),
      pattern: '{ $.message = "turnstile-policy-inactive" }',
      metricTransformation: {
        name: 'TurnstilePolicyInactive',
        namespace: 'test-app/production/Turnstile',
        value: '1',
        unit: 'Count',
      },
    });
    const pattern = resources.filter.mock.calls[0][1].pattern;
    if (typeof pattern !== 'string') throw new Error('Missing metric filter pattern');
    const expression = { test: (line: string) => matchesMessageFilterPattern(pattern, line) };
    const prefix = '2026-10-29T00:00:00.000Z request-id WARN ';
    expect(expression.test(prefix + JSON.stringify({ message: 'turnstile-policy-inactive', reason: 'disabled' }))).toBe(
      true
    );
    expect(
      expression.test(prefix + JSON.stringify({ requestId: 'turnstile-policy-inactive', message: 'req-timing' }))
    ).toBe(false);
  });

  it('alarms on any report in an hour and routes ALARM and OK to Slack and email', async () => {
    await loadAlarms();
    expect(resources.alarm).toHaveBeenCalledWith('turnstilePolicyInactive', {
      name: 'test-app-production-turnstile-policy-inactive',
      alarmDescription: 'The server reported the Turnstile policy inactive in the last hour',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'TurnstilePolicyInactive',
      namespace: 'test-app/production/Turnstile',
      period: 3600,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic', 'email-topic'],
      okActions: ['alarm-topic', 'email-topic'],
      tags: { Application: 'Turnstile', Severity: 'High' },
    });
  });

  it('alarms on the misconfigured message with the same routing', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledWith(
      'turnstileMisconfiguredFilter',
      expect.objectContaining({
        name: 'test-app-production-turnstile-misconfigured',
        pattern: '{ $.message = "turnstile-misconfigured" }',
        metricTransformation: expect.objectContaining({ name: 'TurnstileMisconfigured' }),
      })
    );
    expect(resources.alarm).toHaveBeenCalledWith(
      'turnstileMisconfigured',
      expect.objectContaining({
        name: 'test-app-production-turnstile-misconfigured',
        metricName: 'TurnstileMisconfigured',
        namespace: 'test-app/production/Turnstile',
        threshold: 1,
        alarmActions: ['alarm-topic', 'email-topic'],
        okActions: ['alarm-topic', 'email-topic'],
      })
    );
  });

  it('creates no resources on an unmonitored stage', async () => {
    await loadAlarms('preview');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });

  it('routes the verification spike event to the same alarm destinations', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledWith(
      'cardVerificationFailureSpikeFilter',
      expect.objectContaining({
        pattern: '{ $.message = "card-verification-failure-spike" }',
      })
    );
    expect(resources.alarm).toHaveBeenCalledWith(
      'cardVerificationFailureSpike',
      expect.objectContaining({
        alarmActions: ['alarm-topic', 'email-topic'],
        okActions: ['alarm-topic', 'email-topic'],
      })
    );
    expect(resources.filter).toHaveBeenCalledWith(
      'cardVerificationRecoveryFailureSpikeFilter',
      expect.objectContaining({
        logGroupName: 'recovery-logs',
        pattern: '{ $.message = "card-verification-failure-spike" }',
        metricTransformation: expect.objectContaining({ name: 'CardVerificationFailureSpike' }),
      })
    );
  });

  it('allows a preview to opt in to monitoring', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    await loadAlarms('preview');
    expect(resources.alarm.mock.calls[0][1].namespace).toBe('test-app/preview/Turnstile');
  });

  it('fails loudly when alarm routing is missing', async () => {
    resources.topic = undefined;
    await expect(loadAlarms()).rejects.toThrow('alarm routing requires dlqAlarmTopic');
  });

  it('fails loudly when email routing is missing', async () => {
    resources.oobTopic = undefined;
    await expect(loadAlarms()).rejects.toThrow('oobAlarmTopic');
  });

  it('fails loudly when the server is missing', async () => {
    resources.hasServer = false;
    await expect(loadAlarms()).rejects.toThrow('turnstile policy alarm requires the Next.js server function');
  });

  it('fails loudly when the server log group is missing', async () => {
    resources.logGroup = undefined;
    await expect(loadAlarms()).rejects.toThrow('missing its CloudWatch log group');
  });

  it('exports the module from the infra index', () => {
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain(
      "export * from './turnstileAlarms';"
    );
  });
});
