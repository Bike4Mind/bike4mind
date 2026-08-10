import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiKeyType } from '@bike4mind/common';

const resolveWebSearchProvider = vi.fn();
vi.mock('./tools/implementation/websearch', () => ({
  resolveWebSearchProvider: (...a: unknown[]) => resolveWebSearchProvider(...a),
}));

const getOpenWeatherKey = vi.fn();
const getWolframAlphaKey = vi.fn();
const getFmpApiKey = vi.fn();
const getFirecrawlConfig = vi.fn();
const getEffectiveLLMApiKeys = vi.fn();
const getEffectiveApiKey = vi.fn();
vi.mock('../apiKeyService', () => ({
  getOpenWeatherKey: (...a: unknown[]) => getOpenWeatherKey(...a),
  getWolframAlphaKey: (...a: unknown[]) => getWolframAlphaKey(...a),
  getFmpApiKey: (...a: unknown[]) => getFmpApiKey(...a),
  getFirecrawlConfig: (...a: unknown[]) => getFirecrawlConfig(...a),
  getEffectiveLLMApiKeys: (...a: unknown[]) => getEffectiveLLMApiKeys(...a),
  getEffectiveApiKey: (...a: unknown[]) => getEffectiveApiKey(...a),
}));

import {
  resolveToolAvailability,
  isToolOfferable,
  isLocalImageBackendAvailable,
  isLocalEmbedderAvailable,
} from './toolAvailability';

const db = { apiKeys: {}, adminSettings: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
  resolveWebSearchProvider.mockResolvedValue(null);
  getOpenWeatherKey.mockResolvedValue(undefined);
  getWolframAlphaKey.mockResolvedValue(undefined);
  getFmpApiKey.mockResolvedValue(undefined);
  getFirecrawlConfig.mockResolvedValue({});
  getEffectiveLLMApiKeys.mockResolvedValue(null);
  getEffectiveApiKey.mockResolvedValue(undefined);
});

describe('resolveToolAvailability - search & scrape providers', () => {
  it('reports web_search and deep_research available with only a SearXNG provider (no Firecrawl)', async () => {
    resolveWebSearchProvider.mockResolvedValue({ name: 'searxng', search: vi.fn() });
    const availability = await resolveToolAvailability(undefined, { db });
    expect(availability.web_search).toBe(true);
    // deep_research runs on the search provider with plain-fetch extraction.
    expect(availability.deep_research).toBe(true);
  });

  it('reports both unavailable when neither a provider nor Firecrawl is configured', async () => {
    const availability = await resolveToolAvailability(undefined, { db });
    expect(availability.web_search).toBe(false);
    expect(availability.deep_research).toBe(false);
  });

  it('reports deep_research available from a self-hosted Firecrawl URL alone (web_search still off)', async () => {
    getFirecrawlConfig.mockResolvedValue({ apiUrl: 'http://firecrawl:3002' });
    const availability = await resolveToolAvailability(undefined, { db });
    expect(availability.web_search).toBe(false);
    expect(availability.deep_research).toBe(true);
  });
});

describe('resolveToolAvailability - music_generation and audio_generation ElevenLabs/OpenAI gate', () => {
  it('music_generation is available when an ElevenLabs key resolves', async () => {
    getEffectiveApiKey.mockImplementation(async (_userId: string, sel: { type: ApiKeyType }) =>
      sel.type === ApiKeyType.elevenlabs ? 'el-key' : undefined
    );
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.music_generation).toBe(true);
  });

  it('music_generation is hidden when no ElevenLabs key is configured', async () => {
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.music_generation).toBe(false);
  });

  it('music_generation is hidden for an anonymous (no-user) request', async () => {
    const availability = await resolveToolAvailability(undefined, { db });
    expect(availability.music_generation).toBe(false);
  });

  it('audio_generation is available with only an OpenAI key (no ElevenLabs)', async () => {
    getEffectiveApiKey.mockImplementation(async (_userId: string, sel: { type: ApiKeyType }) =>
      sel.type === ApiKeyType.openai ? 'oai-key' : undefined
    );
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.audio_generation).toBe(true);
    expect(availability.music_generation).toBe(false);
  });

  it('audio_generation is hidden with neither an OpenAI nor an ElevenLabs key', async () => {
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.audio_generation).toBe(false);
  });
});

describe('resolveToolAvailability - search_knowledge_base embedding-key gate', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  const savedOllama = process.env.OLLAMA_BASE_URL;

  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_BASE_URL;
  });
  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedOllama === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = savedOllama;
  });

  it('is available with a real cloud embedding key', async () => {
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-1234567890abcdefABCDEF' });
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.search_knowledge_base).toBe(true);
  });

  it('is NOT available when the only cloud key is a placeholder and no local embedder is configured', async () => {
    // The bug this guards: a placeholder key used to read as a working cloud embedder, so KB
    // advertised a provider the vectorizer would 401 on.
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-oai-dummy-routing-test' });
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.search_knowledge_base).toBe(false);
  });

  it('stays available on a placeholder key when a local Ollama embedder is configured (fallback)', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-oai-dummy-routing-test' });
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.search_knowledge_base).toBe(true);
  });
});

describe('resolveToolAvailability - per-lookup failure isolation', () => {
  it('available policy (default): a failing sub-lookup degrades only its own tool, others resolve normally', async () => {
    getWolframAlphaKey.mockRejectedValue(new Error('admin settings read timed out'));
    resolveWebSearchProvider.mockResolvedValue(null);

    const availability = await resolveToolAvailability(undefined, { db });

    // wolfram_alpha's own lookup failed -> fails open to available under the default policy.
    expect(availability.wolfram_alpha).toBe(true);
    // web_search's lookup succeeded (resolved null) -> reports its real, unaffected value.
    expect(availability.web_search).toBe(false);
  });

  it('unavailable policy: a failing sub-lookup degrades only its own tool to unavailable', async () => {
    getOpenWeatherKey.mockRejectedValue(new Error('boom'));
    resolveWebSearchProvider.mockResolvedValue({ name: 'searxng', search: vi.fn() });

    const availability = await resolveToolAvailability(undefined, { db }, { onLookupError: 'unavailable' });

    expect(availability.weather_info).toBe(false);
    // web_search's own lookup succeeded, unaffected by weather_info's failure.
    expect(availability.web_search).toBe(true);
  });

  it('never rejects even when every sub-lookup throws', async () => {
    resolveWebSearchProvider.mockRejectedValue(new Error('down'));
    getOpenWeatherKey.mockRejectedValue(new Error('down'));
    getWolframAlphaKey.mockRejectedValue(new Error('down'));
    getFmpApiKey.mockRejectedValue(new Error('down'));
    getFirecrawlConfig.mockRejectedValue(new Error('down'));
    getEffectiveLLMApiKeys.mockRejectedValue(new Error('down'));
    getEffectiveApiKey.mockRejectedValue(new Error('down'));

    await expect(resolveToolAvailability('user-1', { db })).resolves.toBeTypeOf('object');
  });

  it('outer-catch safety net honors onLookupError instead of always failing open', async () => {
    // A synchronous throw (not a rejection) bypasses Promise.allSettled entirely and lands in
    // the outer catch - this must still respect the caller's policy, not silently revert an
    // 'unavailable' (fail-closed) caller to an empty, effectively fail-open map.
    resolveWebSearchProvider.mockImplementation(() => {
      throw new Error('sync boom');
    });

    const failOpen = await resolveToolAvailability('user-1', { db });
    expect(failOpen).toEqual({});

    const failClosed = await resolveToolAvailability('user-1', { db }, { onLookupError: 'unavailable' });
    expect(failClosed.weather_info).toBe(false);
    expect(failClosed.image_generation).toBe(false);
    expect(failClosed.edit_image).toBe(false);
    // search_knowledge_base's ENFORCEMENT carve-out lives in isToolOfferable, not in this raw
    // map - the raw map itself is honestly false here too.
    expect(failClosed.search_knowledge_base).toBe(false);
  });
});

describe('resolveToolAvailability - edit_image (own provider set, no xAI, no local backend)', () => {
  it('is available when an eligible provider key resolves (bfl/openai/gemini)', async () => {
    getEffectiveApiKey.mockImplementation(async (_userId: string, sel: { type: ApiKeyType }) =>
      sel.type === ApiKeyType.gemini ? 'gemini-key' : undefined
    );
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.edit_image).toBe(true);
    expect(availability.image_generation).toBe(true);
  });

  it('is unavailable with only an xAI key, even though image_generation is available', async () => {
    getEffectiveApiKey.mockImplementation(async (_userId: string, sel: { type: ApiKeyType }) =>
      sel.type === ApiKeyType.xai ? 'xai-key' : undefined
    );
    const availability = await resolveToolAvailability('user-1', { db });
    expect(availability.image_generation).toBe(true);
    expect(availability.edit_image).toBe(false);
  });

  it('stays unavailable under a self-hosted local image backend, unlike image_generation', async () => {
    // image_generation's local-backend exemption is imageEdit-specific plumbing edit_image has
    // none of (no IMAGE_GEN_BASE_URL branch in imageEdit/index.ts) - a keyless self-host box
    // must not report edit_image as usable just because image_generation is.
    process.env.B4M_SELF_HOST = 'true';
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    try {
      const availability = await resolveToolAvailability('user-1', { db });
      expect(availability.image_generation).toBe(true);
      expect(availability.edit_image).toBe(false);
    } finally {
      delete process.env.B4M_SELF_HOST;
      delete process.env.IMAGE_GEN_BASE_URL;
    }
  });
});

describe('isLocalImageBackendAvailable (image_generation self-host availability rule)', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  const savedUrl = process.env.IMAGE_GEN_BASE_URL;

  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.IMAGE_GEN_BASE_URL;
  });
  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedUrl === undefined) delete process.env.IMAGE_GEN_BASE_URL;
    else process.env.IMAGE_GEN_BASE_URL = savedUrl;
  });

  it('is true when self-host and IMAGE_GEN_BASE_URL is set', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    expect(isLocalImageBackendAvailable()).toBe(true);
  });

  it('is false when IMAGE_GEN_BASE_URL is set but B4M_SELF_HOST is not (hosted deploy)', () => {
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    expect(isLocalImageBackendAvailable()).toBe(false);
  });

  it('is false under self-host when IMAGE_GEN_BASE_URL is unset or blank', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(isLocalImageBackendAvailable()).toBe(false);
    process.env.IMAGE_GEN_BASE_URL = '   ';
    expect(isLocalImageBackendAvailable()).toBe(false);
  });
});

describe('isLocalEmbedderAvailable (search_knowledge_base self-host availability rule)', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  const savedUrl = process.env.OLLAMA_BASE_URL;

  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_BASE_URL;
  });
  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = savedUrl;
  });

  it('is true when self-host and OLLAMA_BASE_URL is set', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(isLocalEmbedderAvailable()).toBe(true);
  });

  it('is false when OLLAMA_BASE_URL is set but B4M_SELF_HOST is not (hosted deploy)', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(isLocalEmbedderAvailable()).toBe(false);
  });

  it('is false under self-host when OLLAMA_BASE_URL is unset or blank', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(isLocalEmbedderAvailable()).toBe(false);
    process.env.OLLAMA_BASE_URL = '   ';
    expect(isLocalEmbedderAvailable()).toBe(false);
  });
});

describe('isToolOfferable (enforcement-only wrapper)', () => {
  it('is true for any tool when availability is undefined (caller has not wired it)', () => {
    expect(isToolOfferable('weather_info', undefined)).toBe(true);
  });

  it('is true for a tool absent from the map (unconditional, per ToolAvailability doc comment)', () => {
    expect(isToolOfferable('navigate_view', { weather_info: false })).toBe(true);
  });

  it('follows the map for a tool present and false', () => {
    expect(isToolOfferable('weather_info', { weather_info: false })).toBe(false);
  });

  it('follows the map for a tool present and true', () => {
    expect(isToolOfferable('weather_info', { weather_info: true })).toBe(true);
  });

  it('search_knowledge_base is always offerable, even when the honest map says false', () => {
    expect(isToolOfferable('search_knowledge_base', { search_knowledge_base: false })).toBe(true);
  });

  it('edit_image follows its own entry, independent of image_generation', () => {
    // Not aliased to image_generation: it supports fewer providers (no xAI), so a user
    // available for one can genuinely be unavailable for the other.
    expect(isToolOfferable('edit_image', { edit_image: false, image_generation: true })).toBe(false);
    expect(isToolOfferable('edit_image', { edit_image: true, image_generation: false })).toBe(true);
  });
});
