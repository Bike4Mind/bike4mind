// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resources = vi.hoisted(() => {
  class FakeOutput<T> {
    constructor(readonly value: T) {}
    apply<Result>(callback: (input: T) => Result) {
      return new FakeOutput(unwrap(callback(this.value)));
    }
  }
  function unwrap(input: unknown): unknown {
    if (input instanceof FakeOutput) return unwrap(input.value);
    if (Array.isArray(input)) return input.map(unwrap);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, unwrap(value)]));
    }
    return input;
  }
  const output = <T>(value: T) => new FakeOutput(value);
  const secretArn = (name: string) => `arn:test:secretsmanager:us-east-2:123456789012:secret:${name}-AbCdEf`;
  type Args = Record<string, unknown>;

  return {
    output,
    unwrap,
    secretArn,
    runsScheduledJobs: true,
    key: vi.fn(function (name: string, _args: Args) {
      return { arn: output(`key-arn-${name}`), keyId: output(`key-id-${name}`) };
    }),
    alias: vi.fn(function (_name: string, _args: Args) {}),
    secret: vi.fn(function (_name: string, args: Args) {
      return { arn: output(secretArn(String(args.name))), name: output(args.name) };
    }),
    secretPolicy: vi.fn(function (_name: string, _args: Args) {}),
    logGroup: vi.fn(function (_name: string, args: Args) {
      return { arn: output(`arn:test:logs:us-east-2:123456789012:log-group:${args.name}`) };
    }),
    logPolicy: vi.fn(function (_name: string, _args: Args) {}),
    rule: vi.fn(function (_name: string, args: Args) {
      return { name: output(args.name) };
    }),
    target: vi.fn(function (_name: string, _args: Args) {}),
    alarm: vi.fn(function (_name: string, _args: Args) {}),
    dashboard: vi.fn(function (_name: string, _args: Args) {}),
    pollerCron: { nodes: { function: { name: 'poller-fn', nodes: { role: { arn: output('arn:role/poller') } } } } } as
      | { nodes: { function: { name: string; nodes: { role: { arn: ReturnType<typeof output<string>> } } } } }
      | undefined,
    reconCron: { nodes: { function: { nodes: { role: { arn: output('arn:role/reconciler') } } } } } as
      { nodes: { function: { nodes: { role: { arn: ReturnType<typeof output<string>> } } } } } | undefined,
    topic: { arn: 'alarm-topic' } as { arn: string } | undefined,
    oobTopic: { arn: 'email-topic' } as { arn: string } | undefined,
  };
});

vi.mock('../constants', () => ({
  get runsScheduledJobs() {
    return resources.runsScheduledJobs;
  },
}));
vi.mock('../cron', () => ({
  get providerUsagePollCron() {
    return resources.pollerCron;
  },
  get spendReconciliationCron() {
    return resources.reconCron;
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
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

type Call = Record<string, unknown>;
const callsOf = (mock: { mock: { calls: unknown[][] } }): Array<[string, Call]> =>
  mock.mock.calls as unknown as Array<[string, Call]>;
const callFor = (mock: { mock: { calls: unknown[][] } }, name: string): Call | undefined =>
  callsOf(mock).find(([logicalName]) => logicalName === name)?.[1];
const resolved = (value: unknown) => resources.unwrap(value);
const policyOf = (call: Call | undefined, field = 'policy') =>
  JSON.parse(resolved(call?.[field]) as string) as { Statement: Array<Record<string, unknown>> };

const POLLER_ROLE = 'arn:role/poller';
const RECONCILER_ROLE = 'arn:role/reconciler';

async function load(stage = 'production') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'test-app', stage });
  return import('../providerSpend');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubGlobal('aws', {
    kms: { Key: resources.key, Alias: resources.alias },
    secretsmanager: { Secret: resources.secret, SecretPolicy: resources.secretPolicy },
    cloudwatch: {
      LogGroup: resources.logGroup,
      LogResourcePolicy: resources.logPolicy,
      EventRule: resources.rule,
      EventTarget: resources.target,
      MetricAlarm: resources.alarm,
      Dashboard: resources.dashboard,
    },
    getPartitionOutput: () => ({ partition: resources.output('test') }),
    getCallerIdentityOutput: () => ({ accountId: resources.output('123456789012') }),
    getRegionOutput: () => ({ name: resources.output('us-east-2') }),
  });
  vi.stubGlobal('$resolve', (input: unknown) => resources.output(resources.unwrap(input)));
  resources.runsScheduledJobs = true;
  resources.pollerCron = {
    nodes: { function: { name: 'poller-fn', nodes: { role: { arn: resources.output(POLLER_ROLE) } } } },
  };
  resources.reconCron = { nodes: { function: { nodes: { role: { arn: resources.output(RECONCILER_ROLE) } } } } };
  resources.topic = { arn: 'alarm-topic' };
  resources.oobTopic = { arn: 'email-topic' };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SECRET_NAMES = {
  anthropic: 'test-app/production/provider-admin-key/anthropic',
  openai: 'test-app/production/provider-admin-key/openai',
};

describe('provider admin key secret policy', () => {
  it.each(['anthropic', 'openai'] as const)(
    'is attached to the %s secret and blocks public policies',
    async provider => {
      await load();
      const call = callFor(resources.secretPolicy, `ProviderAdminKeySecretPolicy-${provider}`);
      expect(call?.blockPublicPolicy).toBe(true);
      expect(resolved(call?.secretArn)).toBe(resources.secretArn(SECRET_NAMES[provider]));
    }
  );

  it('denies reads from every principal except exactly the two spend cron roles', async () => {
    await load();
    const [read] = policyOf(callFor(resources.secretPolicy, 'ProviderAdminKeySecretPolicy-anthropic')).Statement;
    expect(read).toMatchObject({
      Effect: 'Deny',
      Principal: '*',
      Action: 'secretsmanager:GetSecretValue',
      Condition: { ArnNotEquals: { 'aws:PrincipalArn': [POLLER_ROLE, RECONCILER_ROLE] } },
    });
  });

  it('denies replication unconditionally and leaves policy and value changes to the alarms', async () => {
    await load();
    const { Statement } = policyOf(callFor(resources.secretPolicy, 'ProviderAdminKeySecretPolicy-openai'));
    expect(Statement).toHaveLength(2);
    expect(Statement[1]).toEqual({
      Sid: expect.any(String),
      Effect: 'Deny',
      Principal: '*',
      Action: 'secretsmanager:ReplicateSecretToRegions',
      Resource: '*',
    });
    const denied = JSON.stringify(Statement);
    for (const action of ['PutSecretValue', 'PutResourcePolicy', 'DeleteResourcePolicy']) {
      expect(denied).not.toContain(action);
    }
  });

  it('is created on a stage that does not monitor, which creates no rules or alarms', async () => {
    await load('preview');
    expect(resources.secretPolicy).toHaveBeenCalledTimes(2);
    expect(resources.rule).not.toHaveBeenCalled();
    expect(resources.target).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
    expect(resources.logGroup).not.toHaveBeenCalled();
    expect(resources.logPolicy).not.toHaveBeenCalled();
  });

  it('is not created where the store does not exist', async () => {
    resources.runsScheduledJobs = false;
    resources.pollerCron = undefined;
    resources.reconCron = undefined;
    await load();
    expect(resources.key).not.toHaveBeenCalled();
    expect(resources.secretPolicy).not.toHaveBeenCalled();
    expect(resources.rule).not.toHaveBeenCalled();
    expect(resources.logGroup).not.toHaveBeenCalled();
    expect(callFor(resources.alarm, 'ProviderAdminKeyReadAlarm')).toBeUndefined();
  });

  it.each(['pollerCron', 'reconCron'] as const)('fails loudly when the store exists without %s', async missing => {
    resources[missing] = undefined;
    await expect(load()).rejects.toThrow('requires both spend crons');
  });
});

describe('provider admin key access rules', () => {
  const ruleName = (suffix: string) => `test-app-production-provider-admin-key-${suffix}`;
  const patternOf = (logicalName: string) =>
    JSON.parse(resolved(callFor(resources.rule, logicalName)?.eventPattern) as string) as {
      source: string[];
      'detail-type': string[];
      detail: Record<string, unknown>;
    };

  it('creates the read, change and key rules under the stage prefix', async () => {
    await load();
    expect(callsOf(resources.rule).map(([logicalName, args]) => [logicalName, args.name])).toEqual([
      ['ProviderAdminKeyReadRule', ruleName('read')],
      ['ProviderAdminKeyChangeRule', ruleName('change')],
      ['ProviderAdminKeyKmsChangeRule', ruleName('kms-change')],
    ]);
  });

  it('matches secret reads by anything other than the cron roles, in the all-management-events state', async () => {
    await load();
    expect(callFor(resources.rule, 'ProviderAdminKeyReadRule')?.state).toBe(
      'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS'
    );
    const pattern = patternOf('ProviderAdminKeyReadRule');
    expect(pattern.source).toEqual(['aws.secretsmanager']);
    expect(pattern['detail-type']).toEqual(['AWS API Call via CloudTrail']);
    expect(pattern.detail).toMatchObject({
      eventSource: ['secretsmanager.amazonaws.com'],
      eventName: ['GetSecretValue'],
      requestParameters: {
        secretId: [
          SECRET_NAMES.anthropic,
          { prefix: `arn:test:secretsmanager:us-east-2:123456789012:secret:${SECRET_NAMES.anthropic}` },
          SECRET_NAMES.openai,
          { prefix: `arn:test:secretsmanager:us-east-2:123456789012:secret:${SECRET_NAMES.openai}` },
        ],
      },
      $or: [
        {
          userIdentity: {
            sessionContext: { sessionIssuer: { arn: [{ 'anything-but': [POLLER_ROLE, RECONCILER_ROLE] }] } },
          },
        },
        { userIdentity: { type: [{ 'anything-but': ['AssumedRole'] }] } },
      ],
    });
  });

  it('matches every secret and policy change from any principal, without the all-events state', async () => {
    await load();
    expect(callFor(resources.rule, 'ProviderAdminKeyChangeRule')).not.toHaveProperty('state');
    const { detail } = patternOf('ProviderAdminKeyChangeRule');
    expect(detail.eventName).toEqual([
      'PutSecretValue',
      'UpdateSecret',
      'UpdateSecretVersionStage',
      'PutResourcePolicy',
      'DeleteResourcePolicy',
      'DeleteSecret',
      'RestoreSecret',
      'RotateSecret',
      'ReplicateSecretToRegions',
    ]);
    expect(detail).not.toHaveProperty('$or');
    expect(detail.requestParameters).toEqual({
      secretId: expect.arrayContaining([SECRET_NAMES.anthropic, SECRET_NAMES.openai]),
    });
  });

  it('matches changes to the key policy, grants and lifecycle by key id or ARN', async () => {
    await load();
    const pattern = patternOf('ProviderAdminKeyKmsChangeRule');
    expect(pattern.source).toEqual(['aws.kms']);
    expect(pattern.detail).toEqual({
      eventSource: ['kms.amazonaws.com'],
      eventName: ['PutKeyPolicy', 'CreateGrant', 'ScheduleKeyDeletion', 'DisableKey', 'DisableKeyRotation'],
      requestParameters: { keyId: ['key-id-ProviderAdminKeys', 'key-arn-ProviderAdminKeys'] },
    });
  });

  it('keeps the matching CloudTrail records in one log group, behind a policy scoped to it', async () => {
    await load();
    const logGroupArn =
      'arn:test:logs:us-east-2:123456789012:log-group:/aws/events/test-app-production-provider-admin-key-access';
    expect(resources.logGroup).toHaveBeenCalledExactlyOnceWith('ProviderAdminKeyAccessLogs', {
      name: '/aws/events/test-app-production-provider-admin-key-access',
      retentionInDays: 365,
    });
    for (const [, args] of callsOf(resources.target)) expect(resolved(args.arn)).toBe(logGroupArn);
    expect(callsOf(resources.target).map(([logicalName]) => logicalName)).toEqual([
      'ProviderAdminKeyReadTarget',
      'ProviderAdminKeyChangeTarget',
      'ProviderAdminKeyKmsChangeTarget',
    ]);

    expect(resources.logPolicy).toHaveBeenCalledTimes(1);
    const [statement] = policyOf(
      callFor(resources.logPolicy, 'ProviderAdminKeyAccessLogsPolicy'),
      'policyDocument'
    ).Statement;
    expect(statement).toMatchObject({
      Effect: 'Allow',
      Principal: { Service: expect.arrayContaining(['events.amazonaws.com']) },
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: `${logGroupArn}:*`,
    });
  });
});

describe('provider admin key access alarms', () => {
  it.each([
    ['ProviderAdminKeyReadAlarm', 'read'],
    ['ProviderAdminKeyChangeAlarm', 'change'],
    ['ProviderAdminKeyKmsChangeAlarm', 'kms-change'],
  ])('%s pages on any match of its rule', async (logicalName, suffix) => {
    await load();
    const name = `test-app-production-provider-admin-key-${suffix}`;
    expect(callFor(resources.alarm, logicalName)).toEqual({
      name,
      alarmDescription: expect.any(String),
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'MatchedEvents',
      namespace: 'AWS/Events',
      dimensions: { RuleName: name },
      period: 300,
      statistic: 'Sum',
      threshold: 1,
      treatMissingData: 'notBreaching',
      alarmActions: ['alarm-topic', 'email-topic'],
      tags: { Application: 'LLMSpend', Severity: 'Critical' },
    });
  });

  it('describes the read alarm in neutral terms', async () => {
    await load();
    expect(callFor(resources.alarm, 'ProviderAdminKeyReadAlarm')?.alarmDescription).toBe(
      'A principal other than the spend crons read a provider admin key secret'
    );
  });

  it('adds one alarm per rule to the existing provider spend alarms', async () => {
    await load();
    expect(callsOf(resources.alarm).filter(([logicalName]) => logicalName.startsWith('ProviderAdminKey'))).toHaveLength(
      3
    );
    expect(resources.alarm).toHaveBeenCalledTimes(8);
  });

  it('creates nothing alarm-related on a stage that does not monitor', async () => {
    await load('preview');
    expect(resources.alarm).not.toHaveBeenCalled();
    expect(resources.rule).not.toHaveBeenCalled();
  });

  it('fails loudly when alarm routing is missing', async () => {
    resources.topic = undefined;
    await expect(load()).rejects.toThrow('alarm routing requires dlqAlarmTopic and oobAlarmTopic');
  });
});
