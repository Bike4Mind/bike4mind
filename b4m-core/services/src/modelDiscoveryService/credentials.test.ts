import { describe, expect, it, vi } from 'vitest';
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
