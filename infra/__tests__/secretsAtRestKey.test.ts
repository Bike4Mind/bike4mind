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

  it('still denies an untagged caller, a non-preview stage and the chosen-key actions', async () => {
    const statements = await previewStatements();
    const tagDeny = statements.find(s => s.Sid === 'DenyDecryptOutsideApp');
    // StringNotLike is true when the tag is absent, so an untagged principal is denied.
    expect(tagDeny).toMatchObject({ Effect: 'Deny', Principal: '*', Action: ['kms:Decrypt', 'kms:ReEncrypt*'] });
    expect(statements.map(s => s.Sid)).toEqual((await statementsOfDedicated()).map(s => s.Sid));
    expect(JSON.stringify(statements)).not.toContain('production');
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

describe('Decrypt-outside-app event pattern', () => {
  const input = {
    keyArn: 'key-arn',
    partition: 'test',
    accountId: '123456789012',
    appName: 'bike4mind',
    stage: 'production',
  };

  it('matches successful Decrypts on the key by anything but this stage app roles', async () => {
    const { secretsAtRestDecryptOutsideAppEventPattern } = await load('production');
    expect(secretsAtRestDecryptOutsideAppEventPattern(input).detail).toEqual({
      eventSource: ['kms.amazonaws.com'],
      eventName: ['Decrypt'],
      errorCode: [{ exists: false }],
      resources: { ARN: ['key-arn'] },
      $or: [
        {
          userIdentity: {
            sessionContext: {
              sessionIssuer: {
                arn: [{ 'anything-but': { prefix: 'arn:test:iam::123456789012:role/bike4mind-production-' } }],
              },
            },
          },
        },
        { userIdentity: { type: [{ 'anything-but': ['AssumedRole'] }] } },
      ],
    });
  });

  it('is accepted by EventBridge matching: an app role does not match, a non-app role does', async () => {
    const { secretsAtRestDecryptOutsideAppEventPattern } = await load('production');
    const [roleClause] = secretsAtRestDecryptOutsideAppEventPattern(input).detail.$or;
    const [{ 'anything-but': anythingBut }] = roleClause.userIdentity.sessionContext!.sessionIssuer.arn;
    const prefix = (anythingBut as { prefix: string }).prefix;
    const matches = (issuerArn: string) => !issuerArn.startsWith(prefix);
    expect(matches('arn:test:iam::123456789012:role/bike4mind-production-ApiFunctionRole-abc')).toBe(false);
    expect(matches('arn:test:iam::123456789012:role/AWSReservedSSO_Admin_abc')).toBe(true);
    expect(matches('arn:test:iam::123456789012:role/bike4mind-dev-ApiFunctionRole-abc')).toBe(true);
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
