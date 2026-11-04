// @vitest-environment node
import { readFileSync } from 'node:fs';
import { matchesMessageFilterPattern } from './helpers/matchesMessageFilterPattern';
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
    logGroup: { name: 'vectorize-subscriber-logs' } as { name: string } | undefined,
  };
});

vi.mock('../queues', () => ({
  fabFileVectorizeQueueSubscription: {
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
  return import('../vectorizeAlarms');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubGlobal('aws', {
    cloudwatch: { LogMetricFilter: resources.filter, MetricAlarm: resources.alarm },
  });
  resources.topic = { arn: 'alarm-topic' };
  resources.logGroup = { name: 'vectorize-subscriber-logs' };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('embedding billing check alarm', () => {
  it('counts the billing check retry log and alarms on one failure in five minutes', async () => {
    await load();
    expect(resources.filter).toHaveBeenCalledExactlyOnceWith('embeddingBillingCheckRetriesFilter', {
      name: 'test-app-production-embedding-billing-check-retries',
      logGroupName: expect.objectContaining({ value: 'vectorize-subscriber-logs' }),
      pattern: '{ $.message = "embedding-billing-check-retry" }',
      metricTransformation: {
        name: 'EmbeddingBillingCheckRetries',
        namespace: 'test-app/production/Embedding',
        value: '1',
        unit: 'Count',
      },
    });
    expect(resources.alarm).toHaveBeenCalledExactlyOnceWith('embeddingBillingCheckRetries', {
      name: 'test-app-production-embedding-billing-check-retries',
      alarmDescription: 'Embedding jobs deferred after a billing check failure in the last five minutes',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      threshold: 1,
      metricName: 'EmbeddingBillingCheckRetries',
      namespace: 'test-app/production/Embedding',
      period: 300,
      evaluationPeriods: 1,
      statistic: 'Sum',
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic'],
      okActions: ['alarm-topic'],
      tags: { Application: 'Embedding', Severity: 'High' },
    });
  });

  it('matches the event message without counting metadata or unrelated logs', async () => {
    await load();
    const pattern = resources.filter.mock.calls[0][1].pattern;
    if (typeof pattern !== 'string') throw new Error('Missing metric filter pattern');
    const prefix = '2026-11-04T00:00:00.000Z request-id WARN ';
    expect(
      matchesMessageFilterPattern(pattern, prefix + JSON.stringify({ message: 'embedding-billing-check-retry' }))
    ).toBe(true);
    expect(
      matchesMessageFilterPattern(
        pattern,
        prefix + JSON.stringify({ message: 'other-event', error: 'embedding-billing-check-retry' })
      )
    ).toBe(false);
  });

  it('loads the alarm module through the infrastructure entry point', () => {
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain(
      "export * from './vectorizeAlarms';"
    );
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
    await expect(load()).rejects.toThrow('embedding billing check alarm requires dlqAlarmTopic');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });

  it('fails loudly when the subscriber log group is missing', async () => {
    resources.logGroup = undefined;
    await expect(load()).rejects.toThrow('vectorize subscriber function is missing its CloudWatch log group');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });
});
