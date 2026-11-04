// @vitest-environment node
/**
 * /api/tools/web-search and /api/tools/web-fetch billing: the real route chain, the real
 * reserveRequestCredits and creditService hold logic, with only the balances, the provider calls and
 * the ledger write faked. Prices come from the admin settings rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { CREDITS_PER_USD_COST } from '@bike4mind/common';

const {
  mockResolveTrust,
  mockSearch,
  mockSearchProviders,
  mockFetch,
  mockFirecrawlConfig,
  mockDeduct,
  mockSettingsRows,
  mockRecordUsage,
  userIncrement,
  orgIncrement,
  orgFindById,
  counters,
} = vi.hoisted(() => ({
  mockResolveTrust: vi.fn(),
  mockSearch: vi.fn(),
  mockSearchProviders: vi.fn(),
  mockFetch: vi.fn(),
  mockFirecrawlConfig: vi.fn(),
  mockDeduct: vi.fn(),
  mockSettingsRows: vi.fn(),
  mockRecordUsage: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  orgFindById: vi.fn(),
  counters: new Map<string, number>(),
}));

const USER = { id: 'user-1', _id: 'user-1', username: 'jules', tokenVersion: 0, isBanned: false };

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveApiKeyTrust: (...a: unknown[]) => mockResolveTrust(...a),
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/billing/freeTierDailyCapGate', () => ({ checkFreeTierDailySpendCap: vi.fn() }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    apiKeyService: {
      ...(actual.apiKeyService as object),
      getOpenWeatherKey: async () => null,
      getFirecrawlConfig: (...a: unknown[]) => mockFirecrawlConfig(...a),
    },
    creditService: { ...(actual.creditService as object), deductCreditsWithOrgSupport: mockDeduct },
  };
});
vi.mock('@bike4mind/services/llm/tools/implementation/websearch', () => ({
  performWebSearch: (...a: unknown[]) => mockSearch(...a),
  resolveWebSearchProviders: (...a: unknown[]) => mockSearchProviders(...a),
}));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  firecrawlFetch: (...a: unknown[]) => mockFetch(...a),
}));

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: async () => USER }),
    cacheRepository: {
      tryIncrementWithinLimitFixedWindow: async (key: string, limit: number, windowMs: number) => {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return { success: count <= limit, count, expiresAt: new Date(Date.now() + windowMs) };
      },
    },
    toolExecutionLogRepository: { create: async () => ({}) },
    adminSettingsRepository: {
      findBySettingNames: (...a: unknown[]) => mockSettingsRows(...a),
      findBySettingName: async () => null,
    },
    userRepository: {
      ...(actual.userRepository as object),
      findById: async () => USER,
      incrementCredits: userIncrement,
    },
    organizationRepository: { findById: orgFindById, incrementCredits: orgIncrement },
    creditTransactionRepository: {},
    usageEventRepository: { record: mockRecordUsage },
    pendingCreditHoldRepository: {
      record: async () => ({ id: 'pending-hold' }),
      claim: async () => ({ id: 'pending-hold' }),
      markSettled: async () => true,
      findSettlement: async () => null,
    },
    withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    newAccountSpendCapAdapters: {
      adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
      personalSpendSince: async () => [],
    },
  };
});

vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      if (!req.user) req.user = USER;
      next();
    },
  };
});

import webSearch from '../web-search';
import webFetch from '../web-fetch';

// Same rounding the route applies, so the expectations track the platform rate instead of hardcoding it.
const credits = (usd: number) => Math.ceil(usd * CREDITS_PER_USD_COST);
const SEARCH_USD = 0.015;
const FETCH_USD = 0.002;

let settings: Record<string, string>;
const setSettings = (overrides: Record<string, string> = {}) => {
  settings = { enforceCredits: 'true', ...overrides };
};

// any: next-connect handlers take Express req/res; node-mocks-http mocks are not structurally those.
async function call(handler: (req: any, res: any) => unknown, url: string, body: object, user: object = USER) {
  const { req, res } = createMocks(
    { method: 'POST', url, headers: { 'x-forwarded-for': '203.0.113.7' }, body },
    { eventEmitter: EventEmitter }
  );
  req.user = user;
  await handler(req, res);
  return res;
}
const search = (user?: object) => call(webSearch, '/api/tools/web-search', { query: 'q' }, user);
const fetchPage = (user?: object) => call(webFetch, '/api/tools/web-fetch', { url: 'https://example.com/page' }, user);

let userBalance: number;
let orgBalance: number;

describe('/api/tools billing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    setSettings();
    userBalance = 1000;
    orgBalance = 5000;
    mockSettingsRows.mockImplementation(async (names: string[]) =>
      names.filter(name => name in settings).map(name => ({ settingName: name, settingValue: settings[name] }))
    );
    mockResolveTrust.mockResolvedValue({ assessment: { status: 'trusted' }, settings: {} });
    userIncrement.mockImplementation(async (_id: string, delta: number) => ({
      currentCredits: (userBalance += delta),
    }));
    orgIncrement.mockImplementation(async (_id: string, delta: number) => ({ currentCredits: (orgBalance += delta) }));
    orgFindById.mockResolvedValue({ id: 'org-1', currentCredits: 5000 });
    mockDeduct.mockResolvedValue(undefined);
    mockRecordUsage.mockResolvedValue(undefined);
    mockSearchProviders.mockResolvedValue([{ name: 'serpapi' }, null]);
    mockSearch.mockResolvedValue({ formattedResults: 'results', citables: [], servedBy: 'serpapi' });
    mockFirecrawlConfig.mockResolvedValue({ apiKey: 'fc-key' });
    mockFetch.mockResolvedValue({ markdown: 'page body', title: 'Page' });
  });

  describe('web-search', () => {
    it('refuses a payer with no credits before calling the provider', async () => {
      userBalance = 0;
      const res = await search();

      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData()).toMatchObject({ errorCode: 'insufficient_credits' });
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockDeduct).not.toHaveBeenCalled();
      expect(userBalance).toBe(0);
    });

    it('reserves, then settles, the price derived from the SerpApiSearchCostUsd setting', async () => {
      const res = await search();

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ result: 'results' });
      const price = credits(SEARCH_USD);
      expect(userIncrement).toHaveBeenNthCalledWith(1, 'user-1', -price);
      expect(userBalance).toBe(1000 - price);
      expect(mockDeduct).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: 'tool_usage',
          credits: price,
          organization: null,
          model: 'serpapi-web_search',
        }),
        expect.anything(),
        expect.objectContaining({ skipBalanceUpdate: true })
      );
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ feature: 'tool', provider: 'serpapi', model: 'web_search', creditsCharged: price })
      );
    });

    it('re-prices when the admin changes the setting', async () => {
      setSettings({ SerpApiSearchCostUsd: '0.03' });
      await search();

      expect(userIncrement).toHaveBeenNthCalledWith(1, 'user-1', -credits(0.03));
      expect(mockDeduct).toHaveBeenCalledWith(
        expect.objectContaining({ credits: credits(0.03) }),
        expect.anything(),
        expect.anything()
      );
    });

    it('releases the hold when the provider fails', async () => {
      mockSearch.mockRejectedValue(new Error('provider down'));
      const res = await search();

      expect(res._getStatusCode()).toBe(500);
      expect(userBalance).toBe(1000);
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('charges the organization when the caller is org-billed', async () => {
      const res = await search({ ...USER, organizationId: 'org-1' });

      const price = credits(SEARCH_USD);
      expect(res._getStatusCode()).toBe(200);
      expect(orgIncrement).toHaveBeenNthCalledWith(1, 'org-1', -price);
      expect(userIncrement).not.toHaveBeenCalled();
      expect(orgBalance).toBe(5000 - price);
      expect(mockDeduct).toHaveBeenCalledWith(
        expect.objectContaining({ credits: price, organization: expect.objectContaining({ id: 'org-1' }) }),
        expect.anything(),
        expect.anything()
      );
    });

    it('does not charge a search SearXNG answered', async () => {
      mockSearchProviders.mockResolvedValue([{ name: 'searxng' }, null]);
      mockSearch.mockResolvedValue({ formattedResults: 'results', citables: [], servedBy: 'searxng' });
      const res = await search();

      expect(res._getStatusCode()).toBe(200);
      expect(userIncrement).not.toHaveBeenCalled();
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('refunds a search served from cache', async () => {
      mockSearch.mockResolvedValue({ formattedResults: 'results', citables: [] });
      const res = await search();

      expect(res._getStatusCode()).toBe(200);
      expect(userBalance).toBe(1000);
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('charges nothing on a self-host deployment that does not enforce credits', async () => {
      // enforceCredits is locked on everywhere except self-host (isEnforceCreditsLocked).
      vi.stubEnv('B4M_SELF_HOST', 'true');
      setSettings({ enforceCredits: 'false' });
      userBalance = 0;
      const res = await search();

      expect(res._getStatusCode()).toBe(200);
      expect(userIncrement).not.toHaveBeenCalled();
    });
  });

  describe('web-fetch', () => {
    it('refuses a payer with no credits before calling the provider', async () => {
      userBalance = 0;
      const res = await fetchPage();

      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData()).toMatchObject({ errorCode: 'insufficient_credits' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('reserves, then settles, the price derived from the FirecrawlFetchCostUsd setting', async () => {
      const res = await fetchPage();

      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().result).toContain('page body');
      const price = credits(FETCH_USD);
      expect(userIncrement).toHaveBeenNthCalledWith(1, 'user-1', -price);
      expect(userBalance).toBe(1000 - price);
      expect(mockDeduct).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'tool_usage', credits: price, model: 'firecrawl-web_fetch' }),
        expect.anything(),
        expect.objectContaining({ skipBalanceUpdate: true })
      );
      expect(mockRecordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'firecrawl', model: 'web_fetch', creditsCharged: price })
      );
    });

    it('re-prices when the admin changes the setting', async () => {
      setSettings({ FirecrawlFetchCostUsd: '0.01' });
      await fetchPage();

      expect(userIncrement).toHaveBeenNthCalledWith(1, 'user-1', -credits(0.01));
    });

    it('releases the hold when the provider fails', async () => {
      mockFetch.mockRejectedValue(new Error('scrape failed'));
      const res = await fetchPage();

      expect(res._getStatusCode()).toBe(500);
      expect(userBalance).toBe(1000);
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('charges the organization when the caller is org-billed', async () => {
      const res = await fetchPage({ ...USER, organizationId: 'org-1' });

      const price = credits(FETCH_USD);
      expect(res._getStatusCode()).toBe(200);
      expect(orgIncrement).toHaveBeenNthCalledWith(1, 'org-1', -price);
      expect(userIncrement).not.toHaveBeenCalled();
      expect(mockDeduct).toHaveBeenCalledWith(
        expect.objectContaining({ credits: price, organization: expect.objectContaining({ id: 'org-1' }) }),
        expect.anything(),
        expect.anything()
      );
    });

    it.each([
      ['no Firecrawl configured (direct fetch)', {}],
      ['a self-hosted Firecrawl', { apiKey: 'fc-key', apiUrl: 'http://firecrawl:3002' }],
    ])('does not charge a fetch served by %s', async (_label, config) => {
      mockFirecrawlConfig.mockResolvedValue(config);
      const res = await fetchPage();

      expect(res._getStatusCode()).toBe(200);
      expect(userIncrement).not.toHaveBeenCalled();
      expect(mockDeduct).not.toHaveBeenCalled();
    });
  });
});
