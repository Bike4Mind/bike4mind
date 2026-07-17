import { vi, describe, it, expect } from 'vitest';
import { getEffectiveLLMApiKeys, getSearxngUrl, getWebSearchProviderSetting } from './getEffective';
import type { IAdminSettingsRepository, IApiKeyRepository, IApiKeyDocument } from '@bike4mind/common';
import { ApiKeyType } from '@bike4mind/common';

const makeAdminSettingsRepo = (settings: Record<string, string | null> = {}): IAdminSettingsRepository =>
  ({
    findBySettingName: vi.fn(),
    findBySettingNames: vi.fn(async (names: string[]) =>
      names.filter(n => n in settings && settings[n] !== null).map(n => ({ settingName: n, settingValue: settings[n] }))
    ),
    findAll: vi.fn(async () => []),
  }) as unknown as IAdminSettingsRepository;

const makeApiKeyRepo = (
  keys: Partial<IApiKeyDocument>[] = []
): Pick<IApiKeyRepository, 'findByUserIdAndType' | 'findByUserIdAndTypes'> => ({
  findByUserIdAndType: vi.fn(async () => null),
  findByUserIdAndTypes: vi.fn(async () => keys as IApiKeyDocument[]),
});

const makeGetSettingsByNames = (overrides: Record<string, string | null> = {}) =>
  vi.fn(async () => ({
    openaiDemoKey: null,
    anthropicDemoKey: null,
    geminiDemoKey: null,
    bflApiKey: null,
    xaiApiKey: null,
    voyageApiKey: null,
    ollamaBackend: null,
    EnableOllama: null,
    ...overrides,
  }));

describe('getEffectiveLLMApiKeys', () => {
  it('calls injected getSettingsByNames with all required admin setting names', async () => {
    const getSettingsByNames = makeGetSettingsByNames();
    await getEffectiveLLMApiKeys('user-123', {
      db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
      getSettingsByNames,
    });

    expect(getSettingsByNames).toHaveBeenCalledOnce();
    const [names] = getSettingsByNames.mock.calls[0];
    expect(names).toContain('openaiDemoKey');
    expect(names).toContain('anthropicDemoKey');
    expect(names).toContain('geminiDemoKey');
    expect(names).toContain('EnableOllama');
    expect(names).toContain('ollamaBackend');
  });

  it('returns null keys when userId is null and no admin demo keys are set', async () => {
    const result = await getEffectiveLLMApiKeys(null, {
      db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
      getSettingsByNames: makeGetSettingsByNames(),
    });

    expect(result.openai).toBeNull();
    expect(result.anthropic).toBeNull();
    expect(result.ollama).toBeNull();
  });

  it('skips user key lookup when userId is null', async () => {
    const apiKeyRepo = makeApiKeyRepo();
    await getEffectiveLLMApiKeys(null, {
      db: { apiKeys: apiKeyRepo, adminSettings: makeAdminSettingsRepo() },
      getSettingsByNames: makeGetSettingsByNames(),
    });

    expect(apiKeyRepo.findByUserIdAndTypes).not.toHaveBeenCalled();
  });

  it('returns user key when user has a valid openai key', async () => {
    const userKey: Partial<IApiKeyDocument> = {
      type: ApiKeyType.openai,
      apiKey: 'sk-user-key',
      expiresAt: undefined,
    };
    const result = await getEffectiveLLMApiKeys('user-123', {
      db: {
        apiKeys: makeApiKeyRepo([userKey]),
        adminSettings: makeAdminSettingsRepo(),
      },
      getSettingsByNames: makeGetSettingsByNames({ openaiDemoKey: 'sk-demo-key' }),
    });

    // User key takes priority over demo key
    expect(result.openai).toBe('sk-user-key');
  });

  it('falls back to admin demo key when user has no key', async () => {
    const result = await getEffectiveLLMApiKeys('user-123', {
      db: {
        apiKeys: makeApiKeyRepo([]), // no user keys
        adminSettings: makeAdminSettingsRepo(),
      },
      getSettingsByNames: makeGetSettingsByNames({ openaiDemoKey: 'sk-demo-key' }),
    });

    expect(result.openai).toBe('sk-demo-key');
  });

  it('returns the "expired" sentinel when user key is expired (caller is responsible for handling it)', async () => {
    const expiredKey: Partial<IApiKeyDocument> = {
      type: ApiKeyType.openai,
      apiKey: 'sk-expired-key',
      expiresAt: new Date('2000-01-01'), // well in the past
    };
    const result = await getEffectiveLLMApiKeys('user-123', {
      db: {
        apiKeys: makeApiKeyRepo([expiredKey]),
        adminSettings: makeAdminSettingsRepo(),
      },
      getSettingsByNames: makeGetSettingsByNames({ openaiDemoKey: 'sk-demo-key' }),
    });

    // 'expired' is a truthy string so it short-circuits the || demo-key fallback.
    // The sentinel is intentionally surfaced to the caller (e.g. to show an "expired key"
    // warning in the UI) rather than silently swapping in the demo key.
    expect(result.openai).toBe('expired');
  });

  it('enables ollama when EnableOllama is the string "true"', async () => {
    const result = await getEffectiveLLMApiKeys(null, {
      db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
      getSettingsByNames: makeGetSettingsByNames({
        EnableOllama: 'true',
        ollamaBackend: 'http://localhost:11434',
      }),
    });

    expect(result.ollama).toBe('http://localhost:11434');
  });

  it('enables ollama when EnableOllama is the boolean true (stored via legacy path)', async () => {
    const getSettingsByNames = vi.fn(async () => ({
      openaiDemoKey: null,
      anthropicDemoKey: null,
      geminiDemoKey: null,
      bflApiKey: null,
      xaiApiKey: null,
      voyageApiKey: null,
      ollamaBackend: 'http://localhost:11434',
      // Return actual boolean true to simulate legacy DB value
      EnableOllama: true as unknown as string,
    }));

    const result = await getEffectiveLLMApiKeys(null, {
      db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
      getSettingsByNames,
    });

    expect(result.ollama).toBe('http://localhost:11434');
  });

  it('disables ollama when EnableOllama is not set', async () => {
    const result = await getEffectiveLLMApiKeys(null, {
      db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
      getSettingsByNames: makeGetSettingsByNames({
        EnableOllama: null,
        ollamaBackend: 'http://localhost:11434',
      }),
    });

    expect(result.ollama).toBeNull();
  });

  it('propagates the logger option to getSettingsByNames', async () => {
    const getSettingsByNames = makeGetSettingsByNames();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await getEffectiveLLMApiKeys(
      null,
      {
        db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
        getSettingsByNames,
      },
      { logger }
    );

    const [, , options] = getSettingsByNames.mock.calls[0];
    expect(options?.logger).toBe(logger);
  });

  describe('self-host env-key fallback', () => {
    const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
      const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
      Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
      try {
        await fn();
      } finally {
        Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
      }
    };

    it('falls back to .env provider keys under B4M_SELF_HOST when user and demo keys are absent', async () => {
      await withEnv(
        {
          B4M_SELF_HOST: 'true',
          ANTHROPIC_API_KEY: 'sk-ant-env',
          GEMINI_API_KEY: 'gm-env',
          OPENAI_API_KEY: 'sk-oai-env',
          XAI_API_KEY: 'xai-env',
        },
        async () => {
          const result = await getEffectiveLLMApiKeys(null, {
            db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
            getSettingsByNames: makeGetSettingsByNames(),
          });

          expect(result.anthropic).toBe('sk-ant-env');
          expect(result.gemini).toBe('gm-env');
          expect(result.openai).toBe('sk-oai-env');
          expect(result.xai).toBe('xai-env');
          // Only the documented .env.selfhost provider keys get the fallback.
          expect(result.bfl).toBeNull();
          expect(result.voyageai).toBeNull();
        }
      );
    });

    it('ignores the env keys outside self-host (hosted resolution is unchanged)', async () => {
      await withEnv(
        { B4M_SELF_HOST: undefined, ANTHROPIC_API_KEY: 'sk-ant-env', GEMINI_API_KEY: 'gm-env' },
        async () => {
          const result = await getEffectiveLLMApiKeys(null, {
            db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
            getSettingsByNames: makeGetSettingsByNames(),
          });

          expect(result.anthropic).toBeNull();
          expect(result.gemini).toBeNull();
        }
      );
    });

    it('keeps demo-key precedence over the env fallback in self-host', async () => {
      await withEnv({ B4M_SELF_HOST: 'true', ANTHROPIC_API_KEY: 'sk-ant-env' }, async () => {
        const result = await getEffectiveLLMApiKeys(null, {
          db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
          getSettingsByNames: makeGetSettingsByNames({ anthropicDemoKey: 'sk-ant-demo' }),
        });

        expect(result.anthropic).toBe('sk-ant-demo');
      });
    });

    it('treats a blank env key as disabled (whitespace does not enable a provider)', async () => {
      await withEnv({ B4M_SELF_HOST: 'true', ANTHROPIC_API_KEY: '   ' }, async () => {
        const result = await getEffectiveLLMApiKeys(null, {
          db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
          getSettingsByNames: makeGetSettingsByNames(),
        });

        expect(result.anthropic).toBeNull();
      });
    });

    it('enables ollama from OLLAMA_BASE_URL under self-host without the DB admin settings', async () => {
      await withEnv({ B4M_SELF_HOST: 'true', OLLAMA_BASE_URL: 'http://ollama:11434' }, async () => {
        const result = await getEffectiveLLMApiKeys(null, {
          db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
          // EnableOllama / ollamaBackend intentionally unset (fresh install).
          getSettingsByNames: makeGetSettingsByNames(),
        });

        expect(result.ollama).toBe('http://ollama:11434');
      });
    });

    it('ignores OLLAMA_BASE_URL outside self-host', async () => {
      await withEnv({ B4M_SELF_HOST: undefined, OLLAMA_BASE_URL: 'http://ollama:11434' }, async () => {
        const result = await getEffectiveLLMApiKeys(null, {
          db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
          getSettingsByNames: makeGetSettingsByNames(),
        });

        expect(result.ollama).toBeNull();
      });
    });

    it('lets an explicit admin ollamaBackend take precedence over OLLAMA_BASE_URL', async () => {
      await withEnv({ B4M_SELF_HOST: 'true', OLLAMA_BASE_URL: 'http://ollama:11434' }, async () => {
        const result = await getEffectiveLLMApiKeys(null, {
          db: { apiKeys: makeApiKeyRepo(), adminSettings: makeAdminSettingsRepo() },
          getSettingsByNames: makeGetSettingsByNames({
            EnableOllama: 'true',
            ollamaBackend: 'http://admin-configured:11434',
          }),
        });

        expect(result.ollama).toBe('http://admin-configured:11434');
      });
    });
  });
});

describe('getSearxngUrl / getWebSearchProviderSetting', () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
    try {
      await fn();
    } finally {
      Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
    }
  };

  const adaptersFor = (settings: Record<string, string | null>) => ({
    db: {
      adminSettings: {
        findBySettingName: vi.fn(async (name: string) =>
          name in settings && settings[name] !== null ? { settingName: name, settingValue: settings[name] } : null
        ),
      },
    },
  });
  // Only db.adminSettings.findBySettingName is exercised by these getters.
  const adapters = (settings: Record<string, string | null>) =>
    adaptersFor(settings) as unknown as Parameters<typeof getSearxngUrl>[0];

  it('returns the admin SearxngUrl when set', async () => {
    expect(await getSearxngUrl(adapters({ SearxngUrl: 'http://admin:8080' }))).toBe('http://admin:8080');
  });

  it('falls back to SEARXNG_BASE_URL under B4M_SELF_HOST when no admin URL is set', async () => {
    await withEnv({ B4M_SELF_HOST: 'true', SEARXNG_BASE_URL: 'http://searxng:8080' }, async () => {
      expect(await getSearxngUrl(adapters({}))).toBe('http://searxng:8080');
    });
  });

  it('ignores SEARXNG_BASE_URL outside self-host', async () => {
    await withEnv({ B4M_SELF_HOST: undefined, SEARXNG_BASE_URL: 'http://searxng:8080' }, async () => {
      expect(await getSearxngUrl(adapters({}))).toBeNull();
    });
  });

  it('prefers the admin SearxngUrl over the env fallback', async () => {
    await withEnv({ B4M_SELF_HOST: 'true', SEARXNG_BASE_URL: 'http://searxng:8080' }, async () => {
      expect(await getSearxngUrl(adapters({ SearxngUrl: 'http://admin:8080' }))).toBe('http://admin:8080');
    });
  });

  it('returns the provider setting when set, else null', async () => {
    expect(await getWebSearchProviderSetting(adapters({ WebSearchProvider: 'searxng' }))).toBe('searxng');
    expect(await getWebSearchProviderSetting(adapters({}))).toBeNull();
  });
});
