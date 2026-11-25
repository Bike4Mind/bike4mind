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
  vi.stubGlobal('aws', { kms: { Key: state.key, Alias: state.alias } });
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

const policyInput = {
  partition: 'test',
  accountId: '123456789012',
  region: 'us-east-2',
  appName: 'app',
  stage: 'production',
  ecsRoleArns: ['arn:test:iam::123456789012:role/ecs'],
  pinStage: true,
};

describe('key policy', () => {
  it('pins purpose and stage on dedicated keys, and keeps account administration', async () => {
    const { secretsAtRestKeyPolicy } = await load('production');
    const statements = secretsAtRestKeyPolicy(policyInput).Statement;
    expect(statements.find(s => s.Sid === 'EnableAccountAdministration')?.Effect).toBe('Allow');
    expect(statements.find(s => s.Sid === 'DenyWithoutPurposeContext')?.Condition).toEqual({
      StringNotEquals: { 'kms:EncryptionContext:purpose': 'secrets-at-rest' },
    });
    expect(statements.find(s => s.Sid === 'DenyWithoutStageContext')?.Condition).toEqual({
      StringNotEquals: { 'kms:EncryptionContext:stage': 'production' },
    });
  });

  it('drops the stage pin on the shared preview policy', async () => {
    const { secretsAtRestKeyPolicy } = await load('pr1');
    const sids = secretsAtRestKeyPolicy({ ...policyInput, pinStage: false }).Statement.map(s => s.Sid);
    expect(sids).toContain('DenyWithoutPurposeContext');
    expect(sids).not.toContain('DenyWithoutStageContext');
  });

  it('denies Decrypt to anything that is not this stage Function or an ECS task role', async () => {
    const { secretsAtRestKeyPolicy } = await load('production');
    const deny = secretsAtRestKeyPolicy(policyInput).Statement.find(s => s.Sid === 'DenyDecryptOutsideApp');
    expect(deny?.Action).toContain('kms:Decrypt');
    expect(deny?.Condition).toEqual({
      ArnNotLike: { 'lambda:SourceFunctionArn': 'arn:test:lambda:us-east-2:123456789012:function:app-production-*' },
      ArnNotEquals: { 'aws:PrincipalArn': ['arn:test:iam::123456789012:role/ecs'] },
    });
  });

  it('never allows an operator to mint plaintext or unwrap, only GenerateDataKeyWithoutPlaintext with context', async () => {
    const { secretsAtRestKeyPolicy } = await load('production');
    const denied = secretsAtRestKeyPolicy(policyInput)
      .Statement.filter(s => s.Effect === 'Deny')
      .flatMap(s => s.Action as string[]);
    expect(denied).toContain('kms:GenerateDataKeyWithoutPlaintext');
  });
});

describe('Decrypt-outside-app event pattern', () => {
  it('excludes the stage Functions and ECS roles, and still matches non-role callers', async () => {
    const { secretsAtRestDecryptOutsideAppEventPattern } = await load('production');
    const pattern = secretsAtRestDecryptOutsideAppEventPattern({
      keyArn: 'key-arn',
      appName: 'app',
      stage: 'production',
      ecsRoleArns: ['ecs-role'],
    });
    expect(pattern.detail.resources).toEqual({ ARN: ['key-arn'] });
    const [roleBranch, otherBranch] = pattern.detail.$or;
    expect(roleBranch.userIdentity.arn).toEqual([{ 'anything-but': { wildcard: ['*/app-production-*'] } }]);
    expect(roleBranch.userIdentity).toMatchObject({
      sessionContext: { sessionIssuer: { arn: [{ 'anything-but': ['ecs-role'] }] } },
    });
    expect(otherBranch.userIdentity.type).toEqual([{ 'anything-but': ['AssumedRole'] }]);
  });
});

describe('resolveSecretsAtRestKey', () => {
  it('creates a key and alias on stages that run scheduled jobs', async () => {
    state.runsScheduledJobs = true;
    const { secretsAtRestKey } = await load('production');
    expect(secretsAtRestKey?.kind).toBe('dedicated');
    expect(state.key).toHaveBeenCalledTimes(1);
    expect(state.key.mock.calls[0][1]).toMatchObject({ enableKeyRotation: true });
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
