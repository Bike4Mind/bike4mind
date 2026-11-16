// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from './helpers/infraSource';

const resources = vi.hoisted(() => {
  const output = <T>(value: T) => ({
    value,
    apply: <Result>(callback: (input: T) => Result) => output(callback(value)),
  });
  type Args = Record<string, unknown>;
  return {
    output,
    runsScheduledJobs: true,
    key: vi.fn(function (name: string, _args: Args) {
      return { arn: `key-arn-${name}`, keyId: `key-id-${name}` };
    }),
    alias: vi.fn(function (_name: string, _args: Args) {}),
    secret: vi.fn(function (_name: string, args: Args) {
      return { arn: `secret-arn-${String(args.name)}`, name: args.name };
    }),
  };
});

vi.mock('../constants', () => ({
  get runsScheduledJobs() {
    return resources.runsScheduledJobs;
  },
}));

async function load(stage = 'production') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'test-app', stage });
  return import('../providerAdminKeys');
}

type Call = Record<string, unknown>;
const callFor = (mock: { mock: { calls: unknown[][] } }, name: string) =>
  (mock.mock.calls as unknown as Array<[string, Call]>).find(([logicalName]) => logicalName === name)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('aws', {
    kms: { Key: resources.key, Alias: resources.alias },
    secretsmanager: { Secret: resources.secret },
    getPartitionOutput: () => ({ partition: resources.output('test') }),
    getCallerIdentityOutput: () => ({ accountId: resources.output('123456789012') }),
    getRegionOutput: () => ({ name: resources.output('us-east-2') }),
  });
  vi.stubGlobal('$resolve', (values: unknown[]) =>
    resources.output(values.map(value => (value as { value: unknown }).value))
  );
  resources.runsScheduledJobs = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider admin key store', () => {
  it('does not exist where scheduled jobs do not run', async () => {
    resources.runsScheduledJobs = false;
    const { providerAdminKeyStore } = await load('preview');
    expect(providerAdminKeyStore).toBeUndefined();
    expect(resources.key).not.toHaveBeenCalled();
    expect(resources.secret).not.toHaveBeenCalled();
  });

  it('creates one rotating KMS key with an alias per stage', async () => {
    await load();
    expect(resources.key).toHaveBeenCalledTimes(1);
    const key = callFor(resources.key, 'ProviderAdminKeys');
    expect(key?.enableKeyRotation).toBe(true);
    expect(callFor(resources.alias, 'ProviderAdminKeysAlias')).toEqual({
      name: 'alias/test-app-production-provider-admin-keys',
      targetKeyId: 'key-id-ProviderAdminKeys',
    });
  });

  it('builds the key policy from the caller account and region', async () => {
    const { providerAdminKeyPolicy } = await load();
    const policy = JSON.parse(
      (callFor(resources.key, 'ProviderAdminKeys')?.policy as { value: string } | undefined)?.value ?? 'null'
    );
    expect(policy).toEqual(providerAdminKeyPolicy('test', '123456789012', 'us-east-2'));
  });

  it('creates one secret per provider, named under the stage and encrypted with the key', async () => {
    await load();
    expect(resources.secret).toHaveBeenCalledTimes(2);
    for (const provider of ['anthropic', 'openai']) {
      expect(callFor(resources.secret, `ProviderAdminKey-${provider}`)).toEqual({
        name: `test-app/production/provider-admin-key/${provider}`,
        description: expect.any(String),
        kmsKeyId: 'key-arn-ProviderAdminKeys',
      });
    }
  });

  it('never declares a secret value', () => {
    const source = stripComments(readFileSync(new URL('../providerAdminKeys.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/secretsmanager\.SecretVersion|secretString|secretBinary/i);
  });

  it('keeps the providers in step with the spend alarms', async () => {
    const { PROVIDER_ADMIN_KEY_PROVIDERS } = await load();
    const spend = readFileSync(new URL('../providerSpend.ts', import.meta.url), 'utf8');
    expect(spend).toContain("export const PROVIDER_SPEND_PROVIDERS = ['anthropic', 'openai'] as const;");
    expect([...PROVIDER_ADMIN_KEY_PROVIDERS]).toEqual(['anthropic', 'openai']);
  });
});

describe('provider admin key policies', () => {
  it('lets the account root administer the key and denies use outside Secrets Manager', async () => {
    const { providerAdminKeyPolicy } = await load();
    const { Statement } = providerAdminKeyPolicy('test', '123456789012', 'us-east-2');
    expect(Statement).toEqual([
      {
        Sid: expect.any(String),
        Effect: 'Allow',
        Principal: { AWS: 'arn:test:iam::123456789012:root' },
        Action: 'kms:*',
        Resource: '*',
      },
      {
        Sid: expect.any(String),
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'],
        Resource: '*',
        Condition: { StringNotEquals: { 'kms:ViaService': 'secretsmanager.us-east-2.amazonaws.com' } },
      },
    ]);
  });

  it('denies secret reads outside the given roles and denies replication unconditionally', async () => {
    const { providerAdminKeySecretPolicy } = await load();
    const { Statement } = providerAdminKeySecretPolicy(['arn:role/a', 'arn:role/b']);
    expect(Statement).toEqual([
      {
        Sid: expect.any(String),
        Effect: 'Deny',
        Principal: '*',
        Action: 'secretsmanager:GetSecretValue',
        Resource: '*',
        Condition: { ArnNotEquals: { 'aws:PrincipalArn': ['arn:role/a', 'arn:role/b'] } },
      },
      {
        Sid: expect.any(String),
        Effect: 'Deny',
        Principal: '*',
        Action: 'secretsmanager:ReplicateSecretToRegions',
        Resource: '*',
      },
    ]);
  });

  it('lets EventBridge write only to the given log group', async () => {
    const { providerAdminKeyLogsPolicy } = await load();
    const { Statement } = providerAdminKeyLogsPolicy('arn:logs:group');
    expect(Statement).toHaveLength(1);
    expect(Statement[0]).toMatchObject({ Effect: 'Allow', Resource: 'arn:logs:group:*' });
  });
});

describe('provider admin key event patterns', () => {
  const secrets = [
    {
      name: 'app/stage/provider-admin-key/anthropic',
      arn: 'arn:test:secretsmanager:r:1:secret:app/stage/provider-admin-key/anthropic-Ab12Cd',
    },
    {
      name: 'app/stage/provider-admin-key/openai',
      arn: 'arn:test:secretsmanager:r:1:secret:app/stage/provider-admin-key/openai-Zy98Xw',
    },
  ];

  it('strips only the random suffix from a secret ARN', async () => {
    const { secretArnWithoutSuffix } = await load();
    expect(secretArnWithoutSuffix(secrets[0].arn)).toBe(
      'arn:test:secretsmanager:r:1:secret:app/stage/provider-admin-key/anthropic'
    );
    expect(secretArnWithoutSuffix('arn:test:secretsmanager:r:1:secret:app/key-name')).toBe(
      'arn:test:secretsmanager:r:1:secret:app/key-name'
    );
  });

  it('matches a read by name, full ARN or partial ARN, from anything but the allowed roles', async () => {
    const { providerAdminKeyReadEventPattern } = await load();
    expect(providerAdminKeyReadEventPattern({ secrets, allowedRoleArns: ['arn:role/a', 'arn:role/b'] })).toEqual({
      source: ['aws.secretsmanager'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: {
        eventSource: ['secretsmanager.amazonaws.com'],
        eventName: ['GetSecretValue'],
        requestParameters: {
          secretId: [
            'app/stage/provider-admin-key/anthropic',
            { prefix: 'arn:test:secretsmanager:r:1:secret:app/stage/provider-admin-key/anthropic' },
            'app/stage/provider-admin-key/openai',
            { prefix: 'arn:test:secretsmanager:r:1:secret:app/stage/provider-admin-key/openai' },
          ],
        },
        $or: [
          {
            userIdentity: {
              sessionContext: { sessionIssuer: { arn: [{ 'anything-but': ['arn:role/a', 'arn:role/b'] }] } },
            },
          },
          { userIdentity: { type: [{ 'anything-but': ['AssumedRole'] }] } },
        ],
      },
    });
  });

  it('matches every write to a secret or its policy from any principal', async () => {
    const { providerAdminKeyChangeEventPattern } = await load();
    const pattern = providerAdminKeyChangeEventPattern({ secrets });
    expect(pattern.detail.eventName).toEqual([
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
    expect(pattern.detail.requestParameters.secretId).toHaveLength(4);
    expect(pattern.detail).not.toHaveProperty('$or');
  });

  it('matches changes to the key policy, grants and lifecycle by key id or ARN', async () => {
    const { providerAdminKeyKmsEventPattern } = await load();
    expect(providerAdminKeyKmsEventPattern({ keyId: 'key-1', keyArn: 'arn:key-1' })).toEqual({
      source: ['aws.kms'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: {
        eventSource: ['kms.amazonaws.com'],
        eventName: ['PutKeyPolicy', 'CreateGrant', 'ScheduleKeyDeletion', 'DisableKey', 'DisableKeyRotation'],
        requestParameters: { keyId: ['key-1', 'arn:key-1'] },
      },
    });
  });
});

describe('spend cron access to the store', () => {
  it('is empty without the store, so the linked Config secrets stay the source', async () => {
    const { providerAdminKeyCronAccess } = await load();
    expect(providerAdminKeyCronAccess(undefined)).toEqual({ environment: {}, permissions: [] });
  });

  it('exposes the secret ARNs and permits only reading them and decrypting with the key', async () => {
    const { providerAdminKeyCronAccess, providerAdminKeyStore } = await load();
    expect(providerAdminKeyCronAccess(providerAdminKeyStore)).toEqual({
      environment: {
        PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC: 'secret-arn-test-app/production/provider-admin-key/anthropic',
        PROVIDER_ADMIN_KEY_SECRET_OPENAI: 'secret-arn-test-app/production/provider-admin-key/openai',
      },
      permissions: [
        {
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            'secret-arn-test-app/production/provider-admin-key/anthropic',
            'secret-arn-test-app/production/provider-admin-key/openai',
          ],
        },
        { actions: ['kms:Decrypt'], resources: ['key-arn-ProviderAdminKeys'] },
      ],
    });
  });

  it('uses the env var names the workers resolver reads', async () => {
    const { providerAdminKeyEnvName } = await load();
    const resolver = readFileSync(new URL('../../apps/workers/src/cron/providerAdminKey.ts', import.meta.url), 'utf8');
    expect(resolver).toContain('`PROVIDER_ADMIN_KEY_SECRET_${provider.toUpperCase()}`');
    expect(providerAdminKeyEnvName('anthropic')).toBe('PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC');
    expect(providerAdminKeyEnvName('openai')).toBe('PROVIDER_ADMIN_KEY_SECRET_OPENAI');
  });

  describe('in infra/cron.ts', () => {
    const source = readFileSync(new URL('../cron.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const providerAdminKeyAccess =');
    const declarations = source.slice(start, source.indexOf('// Credit Purchase Reconciliation', start));

    async function loadCrons(storeExists: boolean) {
      const { providerAdminKeyCronAccess, providerAdminKeyStore } = await load();
      const cron = vi.fn(function (_name: string, _args: Record<string, unknown>) {
        return {};
      });
      runInNewContext(declarations, {
        runsScheduledJobs: true,
        sst: { aws: { Cron: cron } },
        lambdaVpc: { id: 'vpc' },
        allSecrets: ['secret-a'],
        DEFAULT_LAMBDA_ENVIRONMENT: { DEFAULT: 'env' },
        providerAdminKeyStore: storeExists ? providerAdminKeyStore : undefined,
        providerAdminKeyCronAccess,
      });
      const fn = (name: string) => {
        const call = cron.mock.calls.find(([logicalName]) => logicalName === name);
        return call?.[1].function as {
          link: string[];
          environment: Record<string, string>;
          permissions: Array<{ actions: string[]; resources: string[] }>;
        };
      };
      return { reconciliation: fn('spendReconciliation'), poller: fn('providerUsagePoll') };
    }

    const storeEnvironment = {
      PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC: 'secret-arn-test-app/production/provider-admin-key/anthropic',
      PROVIDER_ADMIN_KEY_SECRET_OPENAI: 'secret-arn-test-app/production/provider-admin-key/openai',
    };

    it('gives both crons the secret ARNs and the scoped permissions', async () => {
      const { reconciliation, poller } = await loadCrons(true);
      for (const fn of [reconciliation, poller]) {
        expect(fn.environment).toEqual({ DEFAULT: 'env', ...storeEnvironment });
        expect(fn.permissions).toContainEqual({
          actions: ['secretsmanager:GetSecretValue'],
          resources: Object.values(storeEnvironment),
        });
        expect(fn.permissions).toContainEqual({ actions: ['kms:Decrypt'], resources: ['key-arn-ProviderAdminKeys'] });
        expect(fn.link).toEqual(['secret-a']);
      }
    });

    it('keeps the poller metric permission and gives the reconciliation cron only the store permissions', async () => {
      const { reconciliation, poller } = await loadCrons(true);
      expect(poller.permissions).toContainEqual({ actions: ['cloudwatch:PutMetricData'], resources: ['*'] });
      expect(poller.permissions).toHaveLength(3);
      expect(reconciliation.permissions.map(permission => permission.actions)).toEqual([
        ['secretsmanager:GetSecretValue'],
        ['kms:Decrypt'],
      ]);
    });

    it('leaves the environment and linked secrets as before where the store does not exist', async () => {
      const { reconciliation, poller } = await loadCrons(false);
      expect(reconciliation.environment).toEqual({ DEFAULT: 'env' });
      expect(poller.environment).toEqual({ DEFAULT: 'env' });
      expect(reconciliation.permissions).toEqual([]);
      expect(poller.permissions).toEqual([{ actions: ['cloudwatch:PutMetricData'], resources: ['*'] }]);
    });
  });
});
