// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Output = { value: string; apply: <R>(fn: (v: string) => R) => R };

const created = vi.hoisted(() => ({
  rules: [] as { name: string; args: Record<string, unknown> }[],
  targets: [] as string[],
  alarms: [] as { name: string; args: Record<string, unknown> }[],
  functions: [] as { name: string; args: Record<string, unknown> }[],
  key: undefined as { arn: Output; keyId: Output } | undefined,
  kind: 'dedicated' as 'dedicated' | 'shared',
}));

vi.mock('../secrets', () => ({ secrets: { SECRET_DATA_KEY_WRAPPED: 'wrapped-secret' } }));
vi.mock('../vpc', () => ({ lambdaVpc: 'the-vpc' }));
vi.mock('../dlqAlarms', () => ({ dlqAlarmTopic: undefined, oobAlarmTopic: undefined }));
vi.mock('../secretsAtRestKey', async importOriginal => ({
  ...(await importOriginal<typeof import('../secretsAtRestKey')>()),
  get secretsAtRestKey() {
    return { kind: created.kind, arn: 'arn:test:kms:key', key: created.key };
  },
}));
vi.mock('../constants', () => ({ runsScheduledJobs: false, isPreviewStage: false }));

// A stand-in for a Pulumi Output: `apply` runs at once, and the stubbed $resolve unwraps `value`.
const out = <T>(value: T) => ({ value, apply: <R>(fn: (v: T) => R) => fn(value) });

const record = (into: { name: string; args: Record<string, unknown> }[]) =>
  vi.fn(function (name: string, args: Record<string, unknown>) {
    into.push({ name, args });
    return { name, arn: `${name}-arn` };
  });

async function load() {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'app', stage: 'production' });
  vi.stubGlobal('$resolve', (values: { value?: unknown }[]) => ({
    apply: (fn: (v: unknown[]) => unknown) =>
      fn(values.map(v => (v && typeof v === 'object' && 'value' in v ? v.value : v))),
  }));
  vi.stubGlobal('aws', {
    getPartitionOutput: () => ({ partition: 'aws' }),
    getCallerIdentityOutput: () => ({ accountId: '123456789012' }),
    cloudwatch: {
      LogGroup: vi.fn(function () {
        return { arn: out('log-arn') };
      }),
      LogResourcePolicy: vi.fn(),
      EventRule: record(created.rules),
      EventTarget: vi.fn(function (name: string) {
        created.targets.push(name);
      }),
      MetricAlarm: record(created.alarms),
    },
  });
  vi.stubGlobal('sst', { aws: { Function: record(created.functions) } });
  return import('../secretsAtRestKeyAccess');
}

beforeEach(() => {
  created.rules.length = created.targets.length = created.alarms.length = created.functions.length = 0;
  created.key = { arn: out('arn:test:kms:key'), keyId: out('key-id') };
  created.kind = 'dedicated';
});
afterEach(() => vi.unstubAllGlobals());

describe('secrets-at-rest key access wiring', () => {
  it('on a dedicated key, creates the two rules with one alarm each, keyed on the rule name', async () => {
    await load();
    expect(created.rules.map(r => r.name)).toEqual(['SecretsAtRestDecryptRule', 'SecretsAtRestKeyChangeRule']);
    expect(created.targets).toHaveLength(2);
    const ruleNames = created.rules.map(r => r.args.name);
    expect(created.alarms.map(a => (a.args.dimensions as { RuleName: string }).RuleName)).toEqual(ruleNames);
    expect(created.alarms[0].args).toMatchObject({ namespace: 'AWS/Events', metricName: 'MatchedEvents' });
  });

  it('gives the Decrypt rule the all-management-events state, which read-only events need', async () => {
    await load();
    expect(created.rules.find(r => r.name === 'SecretsAtRestDecryptRule')?.args.state).toBe(
      'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS'
    );
    expect(created.rules.find(r => r.name === 'SecretsAtRestKeyChangeRule')?.args.state).toBeUndefined();
  });

  it('keys the refused-Decrypt pattern on the key ARN, and the key-change pattern on id and ARN', async () => {
    await load();
    const denied = JSON.parse(created.rules[0].args.eventPattern as string);
    expect(denied.detail.errorMessage).toEqual([{ wildcard: '*arn:test:kms:key*' }]);
    const change = JSON.parse(created.rules[1].args.eventPattern as string);
    expect(change.detail.requestParameters.keyId).toEqual(['key-id', 'arn:test:kms:key']);
  });

  it('creates no monitoring for the shared preview key, which is alarmed by its owner', async () => {
    created.kind = 'shared';
    created.key = undefined;
    await load();
    expect(created.rules).toEqual([]);
    expect(created.alarms).toEqual([]);
  });

  it('declares the probe in the VPC with the wrapped blob linked, on both key kinds', async () => {
    for (const kind of ['dedicated', 'shared'] as const) {
      created.functions.length = 0;
      created.kind = kind;
      created.key = kind === 'shared' ? undefined : { arn: out('arn:test:kms:key'), keyId: out('key-id') };
      await load();
      expect(created.functions).toHaveLength(1);
      expect(created.functions[0].args).toMatchObject({
        handler: 'apps/workers/src/security/secretsAtRestUnwrapProbe.handler',
        vpc: 'the-vpc',
        link: ['wrapped-secret'],
      });
    }
  });
});
