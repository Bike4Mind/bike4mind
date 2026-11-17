// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins the Turbo cache alarms: they exist wherever the cache does (the `dev` stage) and nowhere
 * else, the log filter counts only refused credentials (401), and each alarm watches the cache's
 * own function and bucket.
 */

const created = vi.hoisted(() => ({
  filters: [] as Array<[string, Record<string, unknown>]>,
  alarms: [] as Array<[string, Record<string, unknown>]>,
  topic: { arn: 'alarm-topic' } as { arn: string } | undefined,
}));

vi.mock('../dlqAlarms', () => ({
  get dlqAlarmTopic() {
    return created.topic;
  },
}));
vi.mock('../bucketSecurity', () => ({ BLOCK_ALL_PUBLIC_ACCESS: {}, encryptBucketAtRest: () => {} }));

function output<T>(value: T) {
  return { value, apply: <R>(callback: (input: T) => R) => callback(value) };
}

function stubGlobals(stage: string) {
  created.filters = [];
  created.alarms = [];
  vi.stubGlobal('$dev', false);
  vi.stubGlobal('$app', { name: 'test-app', stage });
  vi.stubGlobal('$interpolate', (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (index < values.length ? String(values[index]) : ''), '')
  );
  vi.stubGlobal('sst', {
    Secret: class {},
    aws: {
      Bucket: class {
        name = 'cache-bucket';
        arn = 'stub-bucket-arn';
      },
      Function: class {
        url = 'https://cache.example';
        nodes = { function: { name: 'cache-function' }, logGroup: output({ name: 'stub-log-group' }) };
      },
    },
  });
  vi.stubGlobal('aws', {
    s3: { BucketLifecycleConfigurationV2: class {} },
    cloudwatch: {
      LogMetricFilter: class {
        constructor(name: string, args: Record<string, unknown>) {
          created.filters.push([name, args]);
        }
      },
      MetricAlarm: class {
        constructor(name: string, args: Record<string, unknown>) {
          created.alarms.push([name, args]);
        }
      },
    },
  });
}

async function load(stage: string) {
  vi.resetModules();
  stubGlobals(stage);
  return import('../turborepoCache');
}

const alarm = (name: string) => created.alarms.find(([logicalName]) => logicalName === name)?.[1];

afterEach(() => {
  vi.unstubAllGlobals();
  created.topic = { arn: 'alarm-topic' };
});

describe('Turbo cache alarms', () => {
  it('creates no alarms on stages without the cache', async () => {
    for (const stage of ['production', 'pr123', 'alice']) {
      const module = await load(stage);
      expect(module.turboCacheAlarms).toBeUndefined();
      expect(created.filters).toEqual([]);
      expect(created.alarms).toEqual([]);
    }
  });

  it('counts only refused credentials from the cache handler log group', async () => {
    await load('dev');
    expect(created.filters).toEqual([
      [
        'turboCacheRejectedFilter',
        expect.objectContaining({
          logGroupName: 'stub-log-group',
          pattern: '{ $.message = "turbo cache request rejected" && $.statusCode = 401 }',
          metricTransformation: expect.objectContaining({ name: 'RejectedRequests', namespace: 'Lumina5/TurboCache' }),
        }),
      ],
    ]);
    expect(alarm('turboCacheRejected')).toMatchObject({
      metricName: 'RejectedRequests',
      namespace: 'Lumina5/TurboCache',
      period: 300,
      statistic: 'Sum',
      threshold: 50,
      alarmActions: ['alarm-topic'],
    });
  });

  it('alarms on throttles and errors of the cache function and on the cache bucket size', async () => {
    await load('dev');
    expect(alarm('turboCacheThrottles')).toMatchObject({
      metricName: 'Throttles',
      namespace: 'AWS/Lambda',
      dimensions: { FunctionName: 'cache-function' },
      threshold: 1,
      alarmActions: ['alarm-topic'],
    });
    expect(alarm('turboCacheErrors')).toMatchObject({
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      dimensions: { FunctionName: 'cache-function' },
      period: 300,
      statistic: 'Sum',
      threshold: 1,
      alarmActions: ['alarm-topic'],
    });
    expect(alarm('turboCacheBucketSize')).toMatchObject({
      metricName: 'BucketSizeBytes',
      namespace: 'AWS/S3',
      dimensions: { BucketName: 'cache-bucket', StorageType: 'StandardStorage' },
      period: 86400,
      threshold: 200 * 1024 ** 3,
      alarmActions: ['alarm-topic'],
    });
    expect(created.alarms.map(([name]) => name)).toEqual([
      'turboCacheRejected',
      'turboCacheThrottles',
      'turboCacheErrors',
      'turboCacheBucketSize',
    ]);
  });

  it('refuses to deploy the cache without an alarm topic', async () => {
    created.topic = undefined;
    await expect(load('dev')).rejects.toThrow('turbo cache alarms require dlqAlarmTopic');
  });
});
