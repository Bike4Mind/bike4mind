import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('@bike4mind/services', () => ({
  apiKeyService: {
    getOpenWeatherKey: vi.fn(async () => null),
    getWolframAlphaKey: vi.fn(async () => null),
    getFmpApiKey: vi.fn(async () => null),
    getFirecrawlConfig: (...a: unknown[]) => getFirecrawlConfig(...a),
    getEffectiveLLMApiKeys: vi.fn(async () => null),
    getEffectiveApiKey: vi.fn(async () => undefined),
  },
}));

import { computeToolAvailability } from '@pages/api/settings/serverConfig';

beforeEach(() => {
  vi.clearAllMocks();
  resolveWebSearchProvider.mockResolvedValue(null);
  getFirecrawlConfig.mockResolvedValue({});
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
