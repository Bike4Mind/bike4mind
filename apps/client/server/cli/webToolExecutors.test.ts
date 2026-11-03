// @vitest-environment node
/**
 * The CLI's billed web tools end to end below the HTTP/WebSocket entry points: the real
 * executeToolWithLogging -> executeServerTool -> executor -> reserveRequestCredits chain, with only the
 * balances, the provider calls and the ledger write faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CREDITS_PER_USD_COST, CreditHolderType } from '@bike4mind/common';

const {
  mockSearch,
  mockSearchProviders,
  mockFetch,
  mockFirecrawlConfig,
  mockDeduct,
  mockSettingsRows,
  mockUserFindById,
  mockRecordUsage,
  userIncrement,
  orgIncrement,
  orgFindById,
} = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockSearchProviders: vi.fn(),
  mockFetch: vi.fn(),
  mockFirecrawlConfig: vi.fn(),
  mockDeduct: vi.fn(),
  mockSettingsRows: vi.fn(),
  mockUserFindById: vi.fn(),
  mockRecordUsage: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  orgFindById: vi.fn(),
}));

vi.mock('@server/billing/freeTierDailyCapGate', () => ({ checkFreeTierDailySpendCap: vi.fn() }));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    apiKeyService: {
      ...(actual.apiKeyService as object),
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
  return {
    ...actual,
    toolExecutionLogRepository: { create: async () => ({}) },
    adminSettingsRepository: {
      findBySettingNames: (...a: unknown[]) => mockSettingsRows(...a),
      findBySettingName: async () => null,
    },
    userRepository: { findById: mockUserFindById, incrementCredits: userIncrement },
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

import { executeToolWithLogging, toolResultStatus } from '@bike4mind/server-utils/cli/toolsHandler.shared';
import { buildWebToolExecutors } from './webToolExecutors';

const credits = (usd: number) => Math.ceil(usd * CREDITS_PER_USD_COST);
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const USER = { id: 'user-1', username: 'jules' };
// The key's holder must still be on the org roster (assertApiKeyOrgMembership).
const ORG = { id: 'org-1', userId: 'owner', users: [{ userId: 'user-1' }], currentCredits: 5000 };
const ORG_KEY = { keyId: 'k1', billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' };

let settings: Record<string, string>;
let userBalance: number;
let orgBalance: number;

const run = (toolName: 'web_search' | 'web_fetch', apiKeyInfo?: Parameters<typeof buildWebToolExecutors>[1]) =>
  executeToolWithLogging(
    { toolName, input: toolName === 'web_search' ? { query: 'q' } : { url: 'https://example.com/page' } },
    { userId: 'user-1', logger, executors: buildWebToolExecutors(logger as never, apiKeyInfo) }
  );

describe('CLI billed web tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = { enforceCredits: 'true' };
    userBalance = 1000;
    orgBalance = 5000;
    mockSettingsRows.mockImplementation(async (names: string[]) =>
      names.filter(name => name in settings).map(name => ({ settingName: name, settingValue: settings[name] }))
    );
    mockUserFindById.mockResolvedValue(USER);
    userIncrement.mockImplementation(async (_id: string, delta: number) => ({
      currentCredits: (userBalance += delta),
    }));
    orgIncrement.mockImplementation(async (_id: string, delta: number) => ({ currentCredits: (orgBalance += delta) }));
    orgFindById.mockResolvedValue(ORG);
    mockDeduct.mockResolvedValue(undefined);
    mockRecordUsage.mockResolvedValue(undefined);
    mockSearchProviders.mockResolvedValue([{ name: 'serpapi' }, null]);
    mockSearch.mockResolvedValue({ formattedResults: 'results', citables: [], servedBy: 'serpapi' });
    mockFirecrawlConfig.mockResolvedValue({ apiKey: 'fc-key' });
    mockFetch.mockResolvedValue({ markdown: 'page body', title: 'Page' });
  });

  describe.each([
    ['web_search', 0.015, () => mockSearch, () => mockSearch.mockRejectedValue(new Error('provider down'))],
    ['web_fetch', 0.002, () => mockFetch, () => mockFetch.mockRejectedValue(new Error('scrape failed'))],
  ] as const)('%s', (toolName, usd, provider, failProvider) => {
    it('answers 422 insufficient_credits without calling the provider when the user has no credits', async () => {
      userBalance = 0;
      const result = await run(toolName);

      expect(result).toMatchObject({ success: false, errorCode: 'insufficient_credits' });
      expect(toolResultStatus(result)).toBe(422);
      expect(provider()).not.toHaveBeenCalled();
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('reserves, then settles, the setting-derived price', async () => {
      const result = await run(toolName);

      expect(result).toMatchObject({ success: true });
      expect(userIncrement).toHaveBeenNthCalledWith(1, 'user-1', -credits(usd));
      expect(userBalance).toBe(1000 - credits(usd));
      expect(mockDeduct).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'tool_usage', credits: credits(usd), source: 'cli' }),
        expect.anything(),
        expect.objectContaining({ skipBalanceUpdate: true })
      );
    });

    it('releases the hold when the provider fails', async () => {
      failProvider();
      const result = await run(toolName);

      expect(result).toMatchObject({ success: false });
      expect(toolResultStatus(result)).toBe(500);
      expect(userBalance).toBe(1000);
      expect(mockDeduct).not.toHaveBeenCalled();
    });

    it('charges the organization for an org-billed API key', async () => {
      const result = await run(toolName, ORG_KEY);

      expect(result).toMatchObject({ success: true });
      expect(orgIncrement).toHaveBeenNthCalledWith(1, 'org-1', -credits(usd));
      expect(userIncrement).not.toHaveBeenCalled();
      expect(mockDeduct).toHaveBeenCalledWith(
        expect.objectContaining({ credits: credits(usd), organization: ORG }),
        expect.anything(),
        expect.anything()
      );
    });

    it('charges the user, not the org seat, for a user-billed API key', async () => {
      mockUserFindById.mockResolvedValue({ ...USER, organizationId: 'org-1' });
      const result = await run(toolName, { keyId: 'k2', billingOwnerType: CreditHolderType.User });

      expect(result).toMatchObject({ success: true });
      expect(userIncrement).toHaveBeenNthCalledWith(1, 'user-1', -credits(usd));
      expect(orgIncrement).not.toHaveBeenCalled();
    });
  });

  it('fails the tool rather than running it un-billed when no executor is wired', async () => {
    const result = await executeToolWithLogging(
      { toolName: 'web_search', input: { query: 'q' } },
      { userId: 'user-1', logger }
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not configured') });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects a web_search without a query before reserving anything', async () => {
    const result = await executeToolWithLogging(
      { toolName: 'web_search', input: {} },
      { userId: 'user-1', logger, executors: buildWebToolExecutors(logger as never) }
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Invalid input') });
    expect(userIncrement).not.toHaveBeenCalled();
  });
});
