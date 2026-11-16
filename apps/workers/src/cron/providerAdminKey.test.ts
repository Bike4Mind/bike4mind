import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_command: unknown): Promise<{ SecretString?: string }> => ({})),
  config: {
    ANTHROPIC_ADMIN_API_KEY: 'config-anthropic-key' as string | undefined,
    OPENAI_ADMIN_API_KEY: 'config-openai-key' as string | undefined,
  },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = mocks.send;
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: mocks.config }));

const { resolveProviderAdminKey } = await import('./providerAdminKey');

const SECRET_ARN =
  'arn:test:secretsmanager:us-east-2:123456789012:secret:app/stage/provider-admin-key/anthropic-AbCdEf';

const namedError = (name: string) => Object.assign(new Error(`${name}: simulated`), { name });

beforeEach(() => {
  mocks.config.ANTHROPIC_ADMIN_API_KEY = 'config-anthropic-key';
  mocks.config.OPENAI_ADMIN_API_KEY = 'config-openai-key';
  vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC', undefined);
  vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_OPENAI', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('resolveProviderAdminKey with the secret store', () => {
  beforeEach(() => {
    vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC', SECRET_ARN);
  });

  it('reads the secret named by the env var and returns the trimmed value', async () => {
    mocks.send.mockResolvedValueOnce({ SecretString: '  sk-ant-admin01-stored\n' });

    expect(await resolveProviderAdminKey('anthropic')).toBe('sk-ant-admin01-stored');
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: { SecretId: SECRET_ARN } }));
  });

  it('ignores the Config secret once the env var is set', async () => {
    mocks.send.mockResolvedValueOnce({ SecretString: 'sk-ant-admin01-stored' });
    expect(await resolveProviderAdminKey('anthropic')).not.toBe('config-anthropic-key');
  });

  it('reads the key again on every call so a rotated value is picked up', async () => {
    mocks.send.mockResolvedValueOnce({ SecretString: 'first' }).mockResolvedValueOnce({ SecretString: 'second' });

    expect(await resolveProviderAdminKey('anthropic')).toBe('first');
    expect(await resolveProviderAdminKey('anthropic')).toBe('second');
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['no string value', undefined],
    ['the not-configured placeholder', 'not-configured'],
  ])('returns undefined for %s, without falling back to Config', async (_label, SecretString) => {
    mocks.send.mockResolvedValueOnce({ SecretString });
    expect(await resolveProviderAdminKey('anthropic')).toBeUndefined();
  });

  it('returns undefined when the secret has no current value yet', async () => {
    mocks.send.mockRejectedValueOnce(namedError('ResourceNotFoundException'));
    expect(await resolveProviderAdminKey('anthropic')).toBeUndefined();
  });

  it.each(['AccessDeniedException', 'DecryptionFailure', 'InternalServiceError'])(
    'rethrows %s instead of treating the key as unconfigured',
    async name => {
      mocks.send.mockRejectedValueOnce(namedError(name));
      await expect(resolveProviderAdminKey('anthropic')).rejects.toThrow(name);
    }
  );

  it('keeps the providers independent: openai without its env var still uses Config', async () => {
    expect(await resolveProviderAdminKey('openai')).toBe('config-openai-key');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('reads the openai secret from its own env var', async () => {
    vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_OPENAI', 'openai-secret-arn');
    mocks.send.mockResolvedValueOnce({ SecretString: 'sk-openai-stored' });

    expect(await resolveProviderAdminKey('openai')).toBe('sk-openai-stored');
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: { SecretId: 'openai-secret-arn' } })
    );
  });
});

describe('resolveProviderAdminKey without the secret store', () => {
  it('returns the Config secret and never calls Secrets Manager', async () => {
    expect(await resolveProviderAdminKey('anthropic')).toBe('config-anthropic-key');
    expect(await resolveProviderAdminKey('openai')).toBe('config-openai-key');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('passes the Config value through untouched, placeholder and absence included', async () => {
    mocks.config.ANTHROPIC_ADMIN_API_KEY = 'not-configured';
    mocks.config.OPENAI_ADMIN_API_KEY = undefined;

    expect(await resolveProviderAdminKey('anthropic')).toBe('not-configured');
    expect(await resolveProviderAdminKey('openai')).toBeUndefined();
  });

  it('treats an empty env var as unset', async () => {
    vi.stubEnv('PROVIDER_ADMIN_KEY_SECRET_ANTHROPIC', '');

    expect(await resolveProviderAdminKey('anthropic')).toBe('config-anthropic-key');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
