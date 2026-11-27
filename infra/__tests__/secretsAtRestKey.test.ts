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
    expect(deny?.Action).toEqual(['kms:Decrypt']);
    expect(deny?.Condition).toEqual({
      StringNotEquals: { 'aws:PrincipalTag/b4m:secrets-at-rest-stage': 'production' },
    });
    expect(JSON.stringify(statements)).not.toContain('lambda:');
  });

  it('denies ReEncrypt to everyone, with no condition', async () => {
    const statements = await statementsOf();
    expect(statements.find(s => s.Sid === 'DenyReEncrypt')).toEqual({
      Sid: 'DenyReEncrypt',
      Effect: 'Deny',
      Principal: '*',
      Action: ['kms:ReEncrypt*'],
      Resource: '*',
    });
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

describe('key policy statements', () => {
  it('pins every statement of the dedicated policy', async () => {
    const { secretsAtRestKeyPolicy } = await load('production');
    const contextActions = ['kms:Decrypt', 'kms:GenerateDataKeyWithoutPlaintext'];
    expect(secretsAtRestKeyPolicy(policyInput).Statement).toEqual([
      {
        Sid: 'EnableAccountAdministration',
        Effect: 'Allow',
        Principal: { AWS: 'arn:test:iam::123456789012:root' },
        Action: 'kms:*',
        Resource: '*',
      },
      {
        Sid: 'DenyWithoutPurposeContext',
        Effect: 'Deny',
        Principal: '*',
        Action: contextActions,
        Resource: '*',
        Condition: { StringNotEquals: { 'kms:EncryptionContext:purpose': 'secrets-at-rest' } },
      },
      {
        Sid: 'DenyWithoutStageContext',
        Effect: 'Deny',
        Principal: '*',
        Action: contextActions,
        Resource: '*',
        Condition: { StringNotEquals: { 'kms:EncryptionContext:stage': 'production' } },
      },
      {
        Sid: 'DenyChosenOrPlaintextDataKey',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:GenerateDataKey', 'kms:Encrypt'],
        Resource: '*',
        Condition: { StringEquals: { 'kms:EncryptionContext:purpose': 'secrets-at-rest' } },
      },
      { Sid: 'DenyReEncrypt', Effect: 'Deny', Principal: '*', Action: ['kms:ReEncrypt*'], Resource: '*' },
      {
        Sid: 'DenyDecryptOutsideApp',
        Effect: 'Deny',
        Principal: '*',
        Action: ['kms:Decrypt'],
        Resource: '*',
        Condition: { StringNotEquals: { 'aws:PrincipalTag/b4m:secrets-at-rest-stage': 'production' } },
      },
    ]);
  });
});

describe('dedicated policy follows the stage input', () => {
  it('differs from the production policy only in the two stage conditions', async () => {
    const { secretsAtRestKeyPolicy } = await load('dev');
    const dev = secretsAtRestKeyPolicy({ ...policyInput, stage: 'dev' });
    const prod = secretsAtRestKeyPolicy(policyInput);
    expect(JSON.parse(JSON.stringify(dev).replaceAll('"dev"', '"production"'))).toEqual(prod);
    expect(JSON.stringify(dev)).not.toContain('production');
    expect(JSON.stringify(dev).match(/"dev"/g)).toHaveLength(2);
  });
});

describe('shared preview key policy', () => {
  const previewStatements = async () => {
    const { secretsAtRestPreviewKeyPolicy } = await load('production');
    return secretsAtRestPreviewKeyPolicy({ partition: 'test', accountId: '123456789012' }).Statement;
  };

  it('pins no single stage: any pr stage passes the context and tag checks', async () => {
    const statements = await previewStatements();
    expect(statements.find(s => s.Sid === 'DenyWithoutStageContext')?.Condition).toEqual({
      StringNotLike: { 'kms:EncryptionContext:stage': 'pr*' },
    });
    expect(statements.find(s => s.Sid === 'DenyDecryptOutsideApp')?.Condition).toEqual({
      StringNotLike: { 'aws:PrincipalTag/b4m:secrets-at-rest-stage': 'pr*' },
    });
  });

  it('still denies an untagged caller and has the same statements as the dedicated policy', async () => {
    const statements = await previewStatements();
    const tagDeny = statements.find(s => s.Sid === 'DenyDecryptOutsideApp');
    // StringNotLike is true when the tag is absent, so an untagged principal is denied.
    expect(tagDeny).toMatchObject({ Effect: 'Deny', Principal: '*', Action: ['kms:Decrypt'] });
    expect(statements.map(s => s.Sid)).toEqual((await statementsOfDedicated()).map(s => s.Sid));
  });

  it('equals the dedicated policy with only the stage conditions swapped for the pr glob', async () => {
    const swap = { StringNotLike: { 'kms:EncryptionContext:stage': 'pr*' } };
    const tagSwap = { StringNotLike: { 'aws:PrincipalTag/b4m:secrets-at-rest-stage': 'pr*' } };
    const expected = (await statementsOfDedicated()).map(s => {
      if (s.Sid === 'DenyWithoutStageContext') return { ...s, Condition: swap };
      if (s.Sid === 'DenyDecryptOutsideApp') return { ...s, Condition: tagSwap };
      return s;
    });
    expect(await previewStatements()).toEqual(expected);
  });

  async function statementsOfDedicated() {
    const { secretsAtRestKeyPolicy } = await load('production');
    return secretsAtRestKeyPolicy(policyInput).Statement;
  }
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
      errorMessage: [{ wildcard: '*key-arn*' }],
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
    const { secretsAtRestKey, secretsAtRestKeyPolicy } = await load('dev');
    expect(secretsAtRestKey?.kind).toBe('dedicated');
    expect(state.key).toHaveBeenCalledTimes(1);
    expect(state.key.mock.calls[0][1]).toMatchObject({ enableKeyRotation: true });
    expect(JSON.parse(state.key.mock.calls[0][1].policy as string)).toEqual(
      secretsAtRestKeyPolicy({ partition: 'test', accountId: '123456789012', stage: 'dev' })
    );
    expect(state.alias.mock.calls[0][1]).toMatchObject({ name: 'alias/app-dev-secrets-at-rest' });
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
