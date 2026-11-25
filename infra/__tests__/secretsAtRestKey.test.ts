// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  runsScheduledJobs: false,
  isPreviewStage: false,
  key: vi.fn(function (_name: string, _args: Record<string, unknown>) {
    return { arn: 'key-arn', keyId: 'key-id' };
  }),
  alias: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
}));

vi.mock('../constants', () => ({
  get runsScheduledJobs() {
    return state.runsScheduledJobs;
  },
  get isPreviewStage() {
    return state.isPreviewStage;
  },
}));

async function load(stage: string, env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'app', stage });
  vi.stubGlobal('$resolve', (values: unknown[]) => ({ apply: (fn: (v: unknown[]) => unknown) => fn(values) }));
  vi.stubGlobal('aws', {
    kms: { Key: state.key, Alias: state.alias },
    getPartitionOutput: () => ({ partition: 'test' }),
    getCallerIdentityOutput: () => ({ accountId: '123456789012' }),
  });
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import('../secretsAtRestKey');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.runsScheduledJobs = false;
  state.isPreviewStage = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const policyInput = { partition: 'test', accountId: '123456789012', stage: 'production' };

describe('key policy', () => {
  const statementsOf = async () => {
    const { secretsAtRestKeyPolicy } = await load('production');
    return secretsAtRestKeyPolicy(policyInput).Statement;
  };

  it('pins purpose and stage, and keeps account administration', async () => {
    const statements = await statementsOf();
    expect(statements.find(s => s.Sid === 'EnableAccountAdministration')?.Effect).toBe('Allow');
    expect(statements.find(s => s.Sid === 'DenyWithoutPurposeContext')?.Condition).toEqual({
      StringNotEquals: { 'kms:EncryptionContext:purpose': 'secrets-at-rest' },
    });
    expect(statements.find(s => s.Sid === 'DenyWithoutStageContext')?.Condition).toEqual({
      StringNotEquals: { 'kms:EncryptionContext:stage': 'production' },
    });
  });

  it('denies Decrypt to any principal not tagged as this stage, using no lambda condition key', async () => {
    const statements = await statementsOf();
    const deny = statements.find(s => s.Sid === 'DenyDecryptOutsideApp');
    expect(deny?.Action).toEqual(['kms:Decrypt', 'kms:ReEncrypt*']);
    expect(deny?.Condition).toEqual({
      StringNotEquals: { 'aws:PrincipalTag/b4m:secrets-at-rest-stage': 'production' },
    });
    expect(JSON.stringify(statements)).not.toContain('lambda:');
  });

  it('denies GenerateDataKey and Encrypt under the purpose context, and leaves GenerateDataKeyWithoutPlaintext minting open', async () => {
    const statements = await statementsOf();
    const chosen = statements.find(s => s.Sid === 'DenyChosenOrPlaintextDataKey');
    expect(chosen).toMatchObject({
      Effect: 'Deny',
      Action: ['kms:GenerateDataKey', 'kms:Encrypt'],
      Condition: { StringEquals: { 'kms:EncryptionContext:purpose': 'secrets-at-rest' } },
    });
    const denyActionsAnyContext = statements
      .filter(s => s.Effect === 'Deny' && !('Condition' in s && s.Condition && 'StringNotEquals' in s.Condition))
      .flatMap(s => s.Action as string[]);
    expect(denyActionsAnyContext).not.toContain('kms:GenerateDataKeyWithoutPlaintext');
    const ownerOnly = statements.filter(s => s.Sid === 'DenyDecryptOutsideApp').flatMap(s => s.Action as string[]);
    expect(ownerOnly).not.toContain('kms:GenerateDataKeyWithoutPlaintext');
  });
});

describe('role tags', () => {
  it('adds the stage tag and keeps the existing ones', async () => {
    const { secretsAtRestRoleTags } = await load('production');
    expect(secretsAtRestRoleTags({ a: 'b' }, 'production')).toEqual({
      a: 'b',
      'b4m:secrets-at-rest-stage': 'production',
    });
    expect(secretsAtRestRoleTags(undefined, 'dev')).toEqual({ 'b4m:secrets-at-rest-stage': 'dev' });
  });
});

describe('Decrypt-denied event pattern', () => {
  it('matches only refused Decrypts on the key, with no caller-name matching', async () => {
    const { secretsAtRestDecryptDeniedEventPattern } = await load('production');
    const pattern = secretsAtRestDecryptDeniedEventPattern({ keyArn: 'key-arn' });
    expect(pattern.detail).toEqual({
      eventSource: ['kms.amazonaws.com'],
      eventName: ['Decrypt'],
      errorCode: ['AccessDenied', 'AccessDeniedException'],
      resources: { ARN: ['key-arn'] },
    });
    expect(JSON.stringify(pattern)).not.toContain('userIdentity');
  });
});

describe('Decrypt permission', () => {
  it('is scoped to the key and pinned to the stage context', async () => {
    const { secretsAtRestDecryptPermission } = await load('production');
    expect(secretsAtRestDecryptPermission('arn:x', 'production')).toEqual({
      actions: ['kms:Decrypt'],
      resources: ['arn:x'],
      conditions: [
        { test: 'StringEquals', variable: 'kms:EncryptionContext:purpose', values: ['secrets-at-rest'] },
        { test: 'StringEquals', variable: 'kms:EncryptionContext:stage', values: ['production'] },
      ],
    });
  });
});

describe('resolveSecretsAtRestKey', () => {
  it('creates a key and alias on stages that run scheduled jobs', async () => {
    state.runsScheduledJobs = true;
    const { secretsAtRestKey } = await load('production');
    expect(secretsAtRestKey?.kind).toBe('dedicated');
    expect(state.key).toHaveBeenCalledTimes(1);
    expect(state.key.mock.calls[0][1]).toMatchObject({ enableKeyRotation: true });
    const policy = JSON.parse(state.key.mock.calls[0][1].policy as string);
    expect(policy.Statement.map((s: { Sid: string }) => s.Sid)).toContain('DenyDecryptOutsideApp');
    expect(state.alias.mock.calls[0][1]).toMatchObject({ name: 'alias/app-production-secrets-at-rest' });
  });

  it('uses the env ARN on a preview and creates no key', async () => {
    state.isPreviewStage = true;
    const { secretsAtRestKey } = await load('pr123', { PREVIEW_SECRETS_AT_REST_KEY_ARN: 'arn:shared' });
    expect(secretsAtRestKey).toEqual({ kind: 'shared', arn: 'arn:shared' });
    expect(state.key).not.toHaveBeenCalled();
  });

  it('resolves nothing on a preview without the env var, and on a personal stage', async () => {
    state.isPreviewStage = true;
    expect((await load('pr123')).secretsAtRestKey).toBeUndefined();
    state.isPreviewStage = false;
    expect((await load('someone', { PREVIEW_SECRETS_AT_REST_KEY_ARN: 'arn:shared' })).secretsAtRestKey).toBeUndefined();
    expect(state.key).not.toHaveBeenCalled();
  });
});
