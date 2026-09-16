import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettingsByNames, invalidateSettingsCache } from '@bike4mind/utils';
import { EXPIRED_KEY_SENTINEL, getDiscoveryCredentials, type DiscoveryCredentialAdapters } from './credentials';

type ResolvedKeys = Awaited<ReturnType<NonNullable<DiscoveryCredentialAdapters['resolveLLMKeys']>>>;

const keys = (overrides: Partial<ResolvedKeys> = {}): ResolvedKeys => ({
  openai: 'sk-openai',
  anthropic: 'sk-anthropic',
  gemini: 'sk-gemini',
  bfl: 'sk-bfl',
  xai: 'sk-xai',
  voyageai: 'sk-voyage',
  ollama: null,
  imageGen: null,
  ...overrides,
});

const adapters = (
  resolved: ResolvedKeys,
  elevenLabsValue?: string
): DiscoveryCredentialAdapters & { resolveLLMKeys: ReturnType<typeof vi.fn> } => {
  const resolveLLMKeys = vi.fn(async () => resolved);
  return {
    resolveLLMKeys,
    db: {
      adminSettings: {
        findBySettingName: vi.fn(async () => (elevenLabsValue ? { settingValue: elevenLabsValue } : null)),
      },
    },
  } as unknown as DiscoveryCredentialAdapters & { resolveLLMKeys: ReturnType<typeof vi.fn> };
};

describe('getDiscoveryCredentials', () => {
  it('resolves through the null user path, never the string "system"', async () => {
    const deps = adapters(keys());

    await getDiscoveryCredentials(deps, {});

    expect(deps.resolveLLMKeys).toHaveBeenCalledTimes(1);
    expect(deps.resolveLLMKeys.mock.calls[0][0]).toBeNull();
  });

  it('treats the expired sentinel as unconfigured rather than as a key', async () => {
    const creds = await getDiscoveryCredentials(adapters(keys({ anthropic: EXPIRED_KEY_SENTINEL })), {});

    expect(creds.anthropic).toBeNull();
    expect(creds.openai).toBe('sk-openai');
  });

  it('treats the unset-secret placeholder as unconfigured on either tier', async () => {
    // DISCOVERY_ENV_KEYS is live on hosted, so on a stage where the secret was
    // never set the placeholder would otherwise beat the AdminSettings key and
    // every call would go out as `Bearer not-configured`.
    const creds = await getDiscoveryCredentials(adapters(keys({ anthropic: 'not-configured' })), {
      OPENAI_API_KEY: 'not-configured',
    });

    expect(creds.openai).toBe('sk-openai');
    expect(creds.anthropic).toBeNull();
  });

  it('resolves ElevenLabs from its own admin setting, not from the LLM key table', async () => {
    const withKey = await getDiscoveryCredentials(adapters(keys(), 'eleven-key'), {});
    const withoutKey = await getDiscoveryCredentials(adapters(keys()), {});

    expect(withKey.elevenlabs).toBe('eleven-key');
    expect(withoutKey.elevenlabs).toBeNull();
  });

  it('reports Bedrock as credential-free when hosted and unconfigured under self-host', async () => {
    const hosted = await getDiscoveryCredentials(adapters(keys()), {});
    const selfHost = await getDiscoveryCredentials(adapters(keys()), { B4M_SELF_HOST: 'true' });

    expect(hosted.awsIam).toBe(true);
    expect(hosted.isSelfHost).toBe(false);
    expect(selfHost.awsIam).toBe(false);
    expect(selfHost.isSelfHost).toBe(true);
  });

  it('prefers the discovery-only env secrets over the demo-key tier', async () => {
    const creds = await getDiscoveryCredentials(adapters(keys({ openai: 'demo-openai', xai: 'demo-xai' })), {
      OPENAI_API_KEY: 'secret-openai',
      XAI_API_KEY: '   ',
    });

    expect(creds.openai).toBe('secret-openai');
    // A blank secret is not a credential, so the demo tier still wins.
    expect(creds.xai).toBe('demo-xai');
  });

  it('forwards skipCache to the key resolver and asks for nothing without it', async () => {
    const cached = adapters(keys());
    const fresh = adapters(keys());

    await getDiscoveryCredentials(cached, {});
    await getDiscoveryCredentials(fresh, {}, { skipCache: true });

    expect(cached.resolveLLMKeys.mock.calls[0][2]).toEqual({ skipCache: undefined });
    expect(fresh.resolveLLMKeys.mock.calls[0][2]).toEqual({ skipCache: true });
  });

  it('leaves every unset provider null instead of inventing a placeholder', async () => {
    const creds = await getDiscoveryCredentials(
      adapters(keys({ openai: null, anthropic: null, gemini: null, bfl: null, xai: null, voyageai: null })),
      {}
    );

    expect([creds.openai, creds.anthropic, creds.gemini, creds.bfl, creds.xai, creds.voyageai]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

/**
 * The cached read and the skipCache read take different repository paths: the
 * cache holds one whole-map entry filled by findAll, and only skipCache calls
 * findBySettingNames. These run the real getSettingsByNames over a fake repo so
 * the interaction under test is the shipped one, not a mock of it.
 */
describe('getDiscoveryCredentials over the real settings cache', () => {
  const DEEPSEEK_SETTING = 'deepseekApiKey';

  let rows: Array<{ settingName: string; settingValue: string }> = [];
  const repo = {
    findAll: vi.fn(async () => rows),
    findBySettingNames: vi.fn(async (names: string[]) => rows.filter(row => names.includes(row.settingName))),
    findBySettingName: vi.fn(async (name: string) => rows.find(row => row.settingName === name) ?? null),
  };
  const deps = {
    db: { adminSettings: repo, apiKeys: { find: vi.fn(async () => []) } },
    getSettingsByNames,
  } as unknown as DiscoveryCredentialAdapters;

  // The cache is a module-level singleton, so an entry left behind leaks into
  // later reads. Its TTL is env dependent: assert on call counts and explicit
  // invalidation rather than by waiting one out.
  beforeEach(() => {
    rows = [];
    vi.clearAllMocks();
    invalidateSettingsCache();
  });
  afterEach(() => invalidateSettingsCache());

  it('serves a scheduled run from the cached map and a manual run from the database', async () => {
    const primed = await getDiscoveryCredentials(deps, {});
    expect(primed.deepseek).toBeNull();

    rows = [{ settingName: DEEPSEEK_SETTING, settingValue: 'sk-deepseek' }];

    const scheduled = await getDiscoveryCredentials(deps, {});
    expect(scheduled.deepseek).toBeNull();
    expect(repo.findAll).toHaveBeenCalledTimes(1);
    expect(repo.findBySettingNames).not.toHaveBeenCalled();

    const manual = await getDiscoveryCredentials(deps, {}, { skipCache: true });
    expect(manual.deepseek).toBe('sk-deepseek');
    expect(repo.findBySettingNames).toHaveBeenCalledTimes(1);

    // Reading past the cache does not refill it, so the next scheduled run still
    // gets the stale map.
    const afterManual = await getDiscoveryCredentials(deps, {});
    expect(afterManual.deepseek).toBeNull();
    expect(repo.findAll).toHaveBeenCalledTimes(1);

    // ElevenLabs is read directly on each call, not through the flag.
    expect(repo.findBySettingName).toHaveBeenCalledTimes(4);
  });

  it('is already fresh in-process once a write invalidates the cache', async () => {
    // Why the product-level repro needs two processes: the settings write calls
    // invalidateSettingsCache, which clears only the writing process's cache.
    await getDiscoveryCredentials(deps, {});
    rows = [{ settingName: DEEPSEEK_SETTING, settingValue: 'sk-deepseek' }];

    invalidateSettingsCache();

    const scheduled = await getDiscoveryCredentials(deps, {});
    expect(scheduled.deepseek).toBe('sk-deepseek');
    expect(repo.findAll).toHaveBeenCalledTimes(2);
  });
});
