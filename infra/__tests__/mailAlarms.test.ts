// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resources = vi.hoisted(() => {
  function output<T>(value: T) {
    return { value, apply: <Result>(callback: (input: T) => Result) => output(callback(value)) };
  }
  return {
    output,
    filter: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    alarm: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    topic: { arn: 'alarm-topic' } as { arn: string } | undefined,
    logGroup: { name: 'email-subscriber-logs' } as { name: string } | undefined,
  };
});

vi.mock('../eventBus', () => ({
  emailSendSubscription: {
    nodes: {
      get function() {
        return resources.output({ nodes: { logGroup: resources.logGroup } });
      },
    },
  },
}));
vi.mock('../dlqAlarms', () => ({
  get dlqAlarmTopic() {
    return resources.topic;
  },
}));
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

async function load(stage = 'production') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'test-app', stage });
  return import('../mailAlarms');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubGlobal('aws', {
    cloudwatch: { LogMetricFilter: resources.filter, MetricAlarm: resources.alarm },
  });
  resources.topic = { arn: 'alarm-topic' };
  resources.logGroup = { name: 'email-subscriber-logs' };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('mail send failure alarm', () => {
  it('counts the subscriber rejection log and alarms on one failure in an hour', async () => {
    await load();
    expect(resources.filter).toHaveBeenCalledExactlyOnceWith('mailSendFailuresFilter', {
      name: 'test-app-production-mail-send-failures',
      logGroupName: expect.objectContaining({ value: 'email-subscriber-logs' }),
      pattern: '"Email delivery failed"',
      metricTransformation: {
        name: 'MailSendFailures',
        namespace: 'test-app/production/Mail',
        value: '1',
        unit: 'Count',
      },
    });
    expect(resources.alarm).toHaveBeenCalledExactlyOnceWith('mailSendFailures', {
      name: 'test-app-production-mail-send-failures',
      alarmDescription: 'Outbound email sends rejected by the mail transport in the last hour',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      threshold: 1,
      metricName: 'MailSendFailures',
      namespace: 'test-app/production/Mail',
      period: 3600,
      evaluationPeriods: 1,
      statistic: 'Sum',
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic'],
      okActions: ['alarm-topic'],
      tags: { Application: 'Mail', Severity: 'High' },
    });
  });

  it.each(['dev', 'production'])('creates resources on %s', async stage => {
    await load(stage);
    expect(resources.filter).toHaveBeenCalledTimes(1);
    expect(resources.alarm).toHaveBeenCalledTimes(1);
  });

  it('skips unmonitored stages before resolving required resources', async () => {
    resources.topic = undefined;
    resources.logGroup = undefined;
    await load('preview');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });

  it('allows another stage to opt in to monitoring', async () => {
    vi.stubEnv('ENABLE_MONITORING', 'true');
    await load('preview');
    expect(resources.filter).toHaveBeenCalledTimes(1);
    expect(resources.alarm).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the notification topic is missing', async () => {
    resources.topic = undefined;
    await expect(load()).rejects.toThrow('mail send failure alarm requires dlqAlarmTopic');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });

  it('fails loudly when the subscriber log group is missing', async () => {
    resources.logGroup = undefined;
    await expect(load()).rejects.toThrow('email-send subscriber function is missing its CloudWatch log group');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });
});
