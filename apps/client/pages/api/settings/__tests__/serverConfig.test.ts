import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep settingsMap/common real; mock only the infra + service seams so the availability
// logic (provider resolution + Firecrawl config) is exercised directly.
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@server/utils/config', () => ({ Config: { GOOGLE_CLIENT_ID: '' } }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: { findBySettingName: vi.fn() },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));

const resolveWebSearchProvider = vi.fn();
vi.mock('@bike4mind/services/llm/tools/implementation/websearch', () => ({
  resolveWebSearchProvider: (...a: unknown[]) => resolveWebSearchProvider(...a),
}));

const getFirecrawlConfig = vi.fn();
const getEffectiveLLMApiKeys = vi.fn();
vi.mock('@bike4mind/services', () => ({
  apiKeyService: {
    getOpenWeatherKey: vi.fn(async () => null),
    getWolframAlphaKey: vi.fn(async () => null),
    getFmpApiKey: vi.fn(async () => null),
    getFirecrawlConfig: (...a: unknown[]) => getFirecrawlConfig(...a),
    getEffectiveLLMApiKeys: (...a: unknown[]) => getEffectiveLLMApiKeys(...a),
    getEffectiveApiKey: vi.fn(async () => undefined),
  },
}));

import { computeToolAvailability } from '@pages/api/settings/serverConfig';

beforeEach(() => {
  vi.clearAllMocks();
  resolveWebSearchProvider.mockResolvedValue(null);
  getFirecrawlConfig.mockResolvedValue({});
  getEffectiveLLMApiKeys.mockResolvedValue(null);
});

describe('computeToolAvailability - search & scrape providers', () => {
  it('reports web_search and deep_research available with only a SearXNG provider (no Firecrawl)', async () => {
    resolveWebSearchProvider.mockResolvedValue({ name: 'searxng', search: vi.fn() });
    getFirecrawlConfig.mockResolvedValue({});

    const availability = await computeToolAvailability(undefined);

    expect(availability.web_search).toBe(true);
    // deep_research runs on the search provider with plain-fetch extraction.
    expect(availability.deep_research).toBe(true);
  });

  it('reports both unavailable when neither a provider nor Firecrawl is configured', async () => {
    resolveWebSearchProvider.mockResolvedValue(null);
    getFirecrawlConfig.mockResolvedValue({});

    const availability = await computeToolAvailability(undefined);

    expect(availability.web_search).toBe(false);
    expect(availability.deep_research).toBe(false);
  });

  it('reports deep_research available from a self-hosted Firecrawl URL alone (web_search still off)', async () => {
    resolveWebSearchProvider.mockResolvedValue(null);
    getFirecrawlConfig.mockResolvedValue({ apiUrl: 'http://firecrawl:3002' });

    const availability = await computeToolAvailability(undefined);

    expect(availability.web_search).toBe(false);
    expect(availability.deep_research).toBe(true);
  });
});

describe('computeToolAvailability - search_knowledge_base embedding-key gate', () => {
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
    const availability = await computeToolAvailability('user-1');
    expect(availability.search_knowledge_base).toBe(true);
  });

  it('is NOT available when the only cloud key is a placeholder and no local embedder is configured', async () => {
    // The bug: a placeholder key used to read as a working cloud embedder, so KB advertised a
    // provider the vectorizer would 401 on.
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-oai-dummy-routing-test' });
    const availability = await computeToolAvailability('user-1');
    expect(availability.search_knowledge_base).toBe(false);
  });

  it('stays available on a placeholder key when a local Ollama embedder is configured (fallback)', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-oai-dummy-routing-test' });
    const availability = await computeToolAvailability('user-1');
    expect(availability.search_knowledge_base).toBe(true);
  });
});
