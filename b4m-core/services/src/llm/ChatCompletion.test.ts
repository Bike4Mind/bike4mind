import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompletionProcess,
  addPairedTool,
  isAbortError,
  isRequestTimeoutError,
  isStreamIdleTimeoutError,
} from './ChatCompletionProcess';
import {
  buildAndSortMessages,
  calculateTotalTokenLength,
  fetchAndProcessPreviousMessages,
  processUrlsFromPrompt,
  shouldTriggerFallback,
  isOverloadedError,
  getLlmWithFallback,
  usdToCredits,
  usdToCreditsStochastic,
} from '@bike4mind/utils';
import { getLlmByModel, getAvailableModels } from '@bike4mind/llm-adapters';
import {
  ChatModels,
  ModelBackend,
  usdToCredits as realUsdToCredits,
  usdToCreditsStochastic as realUsdToCreditsStochastic,
} from '@bike4mind/common';
import { ToolBuilder } from './tools/ToolBuilder';
import { runWithFakeTimers } from './__tests__/helpers/fakeTimers';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return {
    ...actual,
    getLlmByModel: vi.fn(),
    getAvailableModels: vi.fn(),
    resolveDeprecatedModelId: vi.fn((id: string) => id),
    PipelineTimer: vi.fn().mockImplementation(function () {
      return {
        phase: vi.fn(),
        end: vi.fn(),
        toRecord: vi.fn().mockReturnValue({}),
        totalMs: vi.fn().mockReturnValue(0),
        summary: vi.fn().mockReturnValue(''),
      };
    }),
  };
});
vi.mock('@bike4mind/utils', () => ({
  calculateTotalTokenLength: vi.fn(),
  buildAndSortMessages: vi.fn(),
  fetchAndProcessPreviousMessages: vi.fn(),
  getSettingByName: vi.fn().mockResolvedValue(null),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn(),
  usdToCredits: vi.fn(),
  usdToCreditsStochastic: vi.fn(),
  processUrlsFromPrompt: vi.fn(),
  getLastBuildDebugInfo: vi.fn().mockReturnValue({}),
  isOverloadedError: vi.fn().mockReturnValue(false),
  shouldTriggerFallback: vi.fn().mockReturnValue(false),
  getLlmWithFallback: vi.fn().mockResolvedValue(null),
  stripAllToolBlocks: vi.fn().mockImplementation((messages: unknown[]) => messages),
  AdminSettingsCache: vi.fn().mockImplementation(function () {
    return {
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      invalidateAll: vi.fn(),
      getSettingsByNames: vi.fn().mockResolvedValue({}),
    };
  }),
  RapidReplyMappingsCache: vi.fn().mockImplementation(function () {
    return {
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      invalidateAll: vi.fn(),
      getRapidReplyMapping: vi.fn().mockResolvedValue(null),
    };
  }),
  OpenaiModerationsService: vi.fn().mockImplementation(function () {
    return { checkPrompt: vi.fn() };
  }),
  ClientMessageSender: vi.fn().mockImplementation(function () {
    return {
      send: vi.fn(),
      close: vi.fn(),
    };
  }),
  EmbeddingFactory: vi.fn().mockImplementation(function () {
    return {
      embed: vi.fn(),
    };
  }),
  TiktokenTokenizer: vi.fn().mockImplementation(function () {
    return {
      countTokens: vi.fn().mockResolvedValue(100),
      encodeTokens: vi.fn().mockResolvedValue([1, 2, 3]),
      clearCache: vi.fn(),
      getCacheStats: vi.fn().mockReturnValue({ size: 0, keys: [] }),
      warmUpCache: vi.fn().mockResolvedValue(undefined),
    };
  }),
  getSettingsByNames: vi.fn().mockResolvedValue({}),
}));
vi.mock('../apiKeyService', () => ({
  getEffectiveApiKey: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
}));

const mockedGetLlmByModel = vi.mocked(getLlmByModel);
const mockedGetAvailableModels = vi.mocked(getAvailableModels);
const mockedBuildAndSortMessages = vi.mocked(buildAndSortMessages);
const mockedFetchAndProcessPreviousMessages = vi.mocked(fetchAndProcessPreviousMessages);
const mockedProcessUrlsFromPrompt = vi.mocked(processUrlsFromPrompt);
const mockedShouldTriggerFallback = vi.mocked(shouldTriggerFallback);
const mockedIsOverloadedError = vi.mocked(isOverloadedError);
const mockedGetLlmWithFallback = vi.mocked(getLlmWithFallback);
const mockedUsdToCredits = vi.mocked(usdToCredits);
const mockedUsdToCreditsStochastic = vi.mocked(usdToCreditsStochastic);
const mockedCalculateTotalTokenLength = vi.mocked(calculateTotalTokenLength);

const mockDb = {};
const mockStorage = {};
const mockQueue = {};
const mockLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
  debug: vi.fn(),
};
const mockUser = { id: 'user1', currentCredits: 10000 };
const mockAbilityGetter = vi.fn();
const mockAutoNameSession = vi.fn();
const mockSummarizeSession = vi.fn();
const mockGetMcpClient = vi.fn();
const mockLogEvent = vi.fn();
const mockGetScopeFilter = vi.fn();
const mockTokenizer = {
  countTokens: vi.fn().mockResolvedValue(100),
  encodeTokens: vi.fn().mockResolvedValue([1, 2, 3]),
  clearCache: vi.fn(),
  getCacheStats: vi.fn().mockReturnValue({ size: 0, keys: [] }),
  warmUpCache: vi.fn().mockResolvedValue(undefined),
};

const baseOptions = {
  db: mockDb as any,
  storage: mockStorage as any,
  queue: mockQueue as any,
  questProcessUrl: '',
  wsHttpsUrl: '',
  slackWebhookUrl: '',
  abilityGetter: mockAbilityGetter,
  autoNameSession: mockAutoNameSession,
  summarizeSession: mockSummarizeSession,
  getMcpClient: mockGetMcpClient,
  logEvent: mockLogEvent,
  logger: mockLogger as any,
  getScopeFilter: mockGetScopeFilter,
  user: mockUser as any,
  sessionId: 'session1',
  tokenizer: mockTokenizer as any,
};

describe('ChatCompletionProcess', () => {
  let service: ChatCompletionProcess;
  let mockDb: any;
  let mockLogger: any;
  let mockQuest: any;
  let mockSession: any;

  beforeEach(() => {
    mockQuest = {
      id: 'quest1',
      status: 'running',
      promptMeta: { context: {}, performance: {} },
      replies: [],
      type: 'message',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockSession = { id: 'session1', agentIds: [] };
    mockLogger = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      updateMetadata: vi.fn(),
      debug: vi.fn(),
    };
    mockDb = {
      sessions: {
        findById: vi.fn().mockResolvedValue(mockSession),
        update: vi.fn(),
        attachAgent: vi.fn().mockResolvedValue(mockSession),
      },
      organizations: { findById: vi.fn(), update: vi.fn() },
      quests: {
        findById: vi.fn().mockResolvedValue(mockQuest),
        findByIdWithStatus: vi.fn().mockResolvedValue(mockQuest),
        update: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
      },
      mcpServers: { find: vi.fn().mockResolvedValue([]) },
      users: { update: vi.fn() },
      fabfiles: {},
      fabfilechunks: {},
      adminSettings: {},
      questMasterPlans: {},
      connections: {},
      creditTransactions: {},
      agents: {},
      projects: { findById: vi.fn() },
    };
    service = new ChatCompletionProcess(baseOptions as any);
    service.db = mockDb;
    (service as any).statusManager = { sendStatusUpdate: vi.fn() };
    vi.spyOn(service, 'sendStatusUpdate').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'buildOptimizedFeatures').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'loadAdminSettingsAsync').mockResolvedValue({});
    vi.spyOn(service as any, 'getDefaultSettingValue').mockReturnValue(false);
    vi.spyOn(service as any, 'fabFilesToMessages').mockResolvedValue({ promptMessages: [], convertedFabFiles: [] });

    // getLlmByModel resolves from @bike4mind/llm-adapters for both ChatCompletionProcess
    // and sharedToolBuilder. Default to a minimal truthy backend so sharedToolBuilder's
    // truthy check passes; per-test cases override with a full backend.
    mockedGetLlmByModel.mockReset().mockReturnValue({
      complete: vi.fn(),
      currentModel: '',
      getModelInfo: vi.fn().mockResolvedValue([]),
    } as any); // any: minimal mock shape satisfying sharedToolBuilder's truthy check
    mockedGetAvailableModels.mockReset();
    mockedBuildAndSortMessages.mockReset();
    mockedFetchAndProcessPreviousMessages.mockReset();
    mockedProcessUrlsFromPrompt.mockReset();
    mockedShouldTriggerFallback.mockReset();
    mockedIsOverloadedError.mockReset();
    mockedGetLlmWithFallback.mockReset();
    // Reset token/credit mocks so per-test overrides don't leak across tests.
    mockedCalculateTotalTokenLength.mockReset();
    mockedUsdToCredits.mockReset();
    mockTokenizer.countTokens.mockReset().mockResolvedValue(100);
  });

  const startQuestParams = {
    userId: 'user1',
    sessionId: 'session1',
    questId: 'quest1',
    message: 'Hello',
    messageFileIds: [],
    historyCount: 1,
    fabFileIds: [],
    params: { model: ChatModels.GPT4, temperature: 0.5, top_p: 1, max_tokens: 10 },
    queryComplexity: 'simple',
    promptMeta: {},
  };

  describe('resolveEntitlementKeys (fail-safe entitlement resolution)', () => {
    it('returns the injected keys and memoizes (resolves once per process)', async () => {
      const getEnt = vi.fn().mockResolvedValue(['product:pro']);
      (service as any).getEntitlements = getEnt;
      (service as any).entitlementsResolved = false;
      (service as any).entitlementKeys = [];
      expect(await service.resolveEntitlementKeys()).toEqual(['product:pro']);
      expect(await service.resolveEntitlementKeys()).toEqual(['product:pro']);
      expect(getEnt).toHaveBeenCalledTimes(1);
    });

    it('fails SAFE to [] when the resolver throws — no chat-turn regression on any surface', async () => {
      (service as any).getEntitlements = vi.fn().mockRejectedValue(new Error('subscription DB down'));
      (service as any).entitlementsResolved = false;
      (service as any).entitlementKeys = [];
      (service as any).logger = { warn: vi.fn() };
      await expect(service.resolveEntitlementKeys()).resolves.toEqual([]);
      expect((service as any).logger.warn).toHaveBeenCalled();
    });

    it('returns [] when no resolver is injected (neutral, tag-only default)', async () => {
      (service as any).getEntitlements = undefined;
      (service as any).entitlementsResolved = false;
      (service as any).entitlementKeys = [];
      expect(await service.resolveEntitlementKeys()).toEqual([]);
    });
  });

  describe('process', () => {
    it('should process a quest successfully', async () => {
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          await cb(['Hi!']);
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });
      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ChatModels.GPT4,
          type: 'text',
          name: 'GPT-4',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 1000,
          can_stream: false,
          pricing: {},
          supportsImageVariation: false,
        },
      ]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });

      const logger = mockLogger;
      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };

      await expect(service.process({ body, logger })).resolves.not.toThrow();

      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: ['Hi!'],
          status: 'done',
          type: 'message',
        })
      );
    });

    // Billing comes from our local tokenizer, not the provider's reported usage.
    // Provider counts are captured separately (actualInputTokens / actualOutputTokens)
    // for audit and drift detection only, since provider accounting can change without
    // notice (new cache semantics, dropped usage chunks) and would silently shift what
    // users pay. Provider cache token counts are NOT added on top of the local input:
    // the local count already covers the whole prompt, so adding them double-billed the
    // cached portion (see the cache-discount regression test below).
    it('bills from the local tokenizer, not from provider-reported counts', async () => {
      const localInputTokens = 80;
      const localOutputTokens = 40;
      const apiInputTokens = 100; // intentionally different from local
      const apiOutputTokens = 50;

      // calculateTotalTokenLength is mocked at module-load - drive it to return
      // a known local input count so we can assert billing follows it.
      mockedCalculateTotalTokenLength.mockResolvedValue(localInputTokens);
      // mockTokenizer.countTokens controls the output-side local count.
      mockTokenizer.countTokens.mockResolvedValue(localOutputTokens);

      // Delegate to the real implementation (pure fn in @bike4mind/common) so
      // these end-to-end billing assertions can never drift from production pricing.
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      // Pin the settlement draw: rng()=0 rounds up whenever a fraction exists,
      // making the stochastic charge a deterministic ceil for assertions.
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          await cb(['Hi!'], { inputTokens: apiInputTokens, outputTokens: apiOutputTokens });
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });
      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ChatModels.GPT4,
          type: 'text',
          name: 'GPT-4',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 200_000,
          can_stream: false,
          // $10 / 1M input, $30 / 1M output; known cost we can assert against
          pricing: { 200000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
          supportsImageVariation: false,
        },
      ]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });

      const logger = mockLogger;
      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };

      await service.process({ body, logger });

      const updateCall = mockDb.quests.update.mock.calls.find(
        ([arg]: [any]) => arg?.promptMeta?.tokenUsage?.estimatedCost !== undefined
      );
      expect(updateCall).toBeDefined();
      const tokenUsage = updateCall[0].promptMeta.tokenUsage;

      // Billing math uses the LOCAL counts:
      //   80 * 10/1M + 40 * 30/1M = $0.0008 + $0.0012 = $0.002
      //   0.002 * 2000 = 4 credits (whole number - no rounding involved)
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.002, 6);
      expect(tokenUsage.creditsUsed).toBe(4);
      expect(tokenUsage.totalTokens).toBe(localInputTokens + localOutputTokens);

      // Audit fields preserve the PROVIDER counts so we can detect drift.
      expect(tokenUsage.actualInputTokens).toBe(apiInputTokens);
      expect(tokenUsage.actualOutputTokens).toBe(apiOutputTokens);
    });

    // With prompt caching the provider reports the cached part of the prompt as
    // cache_read / cache_creation and shrinks its own `input_tokens` to the uncached
    // tail. Our local tokenizer still counts the whole prompt. Two guarantees:
    //   1. Provider cache counts must never be added on top of the local input (that
    //      double-billed the cached prompt: a trivial Opus call hit 85cr).
    //   2. The cache-read portion is instead discounted to 0.1x of the local input
    //      rate, capped at the local count, so cache only ever lowers the bill.
    // Here cache_read (3000) exceeds the local input (80) so it caps at 80: the whole
    // input is re-rated to 0.1x. cache_creation is ignored entirely.
    it('discounts cached input (capped) and never inflates the bill from provider cache tokens', async () => {
      const localInputTokens = 80;
      const localOutputTokens = 40;

      mockedCalculateTotalTokenLength.mockResolvedValue(localInputTokens);
      mockTokenizer.countTokens.mockResolvedValue(localOutputTokens);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      // Pin the settlement draw: rng()=0 rounds up whenever a fraction exists,
      // making the stochastic charge a deterministic ceil for assertions.
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          // Provider: tiny fresh input, the rest served from / written to cache.
          // These cache counts are large on purpose: they must not be added on top,
          // and cache_read caps at the local input.
          await cb(['Hi!'], {
            inputTokens: 2,
            outputTokens: 14,
            cacheCreationInputTokens: 5000,
            cacheReadInputTokens: 3000,
          });
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });
      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ChatModels.GPT4,
          type: 'text',
          name: 'GPT-4',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 200_000,
          // $10 / 1M input, $30 / 1M output
          pricing: { 200000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
          supportsImageVariation: false,
        },
      ]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });

      const logger = mockLogger;
      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };

      await service.process({ body, logger });

      const updateCall = mockDb.quests.update.mock.calls.find(
        ([arg]: [any]) => arg?.promptMeta?.tokenUsage?.estimatedCost !== undefined
      );
      expect(updateCall).toBeDefined();
      const tokenUsage = updateCall[0].promptMeta.tokenUsage;

      // cache_read (3000) caps at local input (80); credited input = 80 - 80*0.9 = 8.
      //   8 * 10/1M + 40 * 30/1M = $0.00008 + $0.0012 = $0.00128; 2.56 raw -> 3 credits (pinned draw).
      // Strictly cheaper than the un-discounted full local cost ($0.002, 10cr), and far
      // below the previously double-billed ~60+ credits.
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.00128, 6);
      expect(tokenUsage.creditsUsed).toBe(3);
      // Capped value recorded for audit.
      expect(tokenUsage.cacheReadInputTokens).toBe(localInputTokens);
    });

    // A cold turn (provider reports no cache read) bills the full local input; the
    // discount only kicks in on warm follow-ups, and a partial cache read discounts
    // proportionally. Guards that the common cold first-turn cost is unchanged.
    it('bills full local input on a cold turn and discounts proportionally on a partial cache read', async () => {
      const localOutputTokens = 10;
      mockTokenizer.countTokens.mockResolvedValue(localOutputTokens);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      // Pin the settlement draw: rng()=0 rounds up whenever a fraction exists,
      // making the stochastic charge a deterministic ceil for assertions.
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      const runWithCacheRead = async (localInputTokens: number, cacheReadInputTokens?: number) => {
        mockDb.quests.update.mockClear();
        mockedCalculateTotalTokenLength.mockResolvedValue(localInputTokens);
        mockedGetLlmByModel.mockReturnValue({
          complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
            await cb(['Hi!'], { inputTokens: 5, outputTokens: 10, cacheReadInputTokens });
          }),
          getModelInfo: vi.fn().mockResolvedValue([]),
          currentModel: ChatModels.GPT4,
        });
        mockedGetAvailableModels.mockResolvedValue([
          {
            id: ChatModels.GPT4,
            type: 'text',
            name: 'GPT-4',
            backend: ModelBackend.OpenAI,
            max_tokens: 100,
            contextWindow: 200_000,
            pricing: { 200000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
            supportsImageVariation: false,
          },
        ]);
        mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
        mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
        mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });

        await service.process({
          body: { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined },
          logger: mockLogger,
        });
        const updateCall = mockDb.quests.update.mock.calls.find(
          ([arg]: [any]) => arg?.promptMeta?.tokenUsage?.estimatedCost !== undefined
        );
        return updateCall[0].promptMeta.tokenUsage;
      };

      // Cold turn: no cache read, full local input billed.
      //   3000 * 10/1M + 10 * 30/1M = $0.0300 + $0.0003 = $0.0303; 60.6 raw -> 61 credits (pinned draw).
      const cold = await runWithCacheRead(3000, undefined);
      expect(cold.estimatedCost).toBeCloseTo(0.0303, 6);
      expect(cold.creditsUsed).toBe(61);

      // Warm turn: 2800 of the 3000 local input served from cache; credited input
      //   = 3000 - 2800*0.9 = 480. 480 * 10/1M + 10 * 30/1M = $0.0048 + $0.0003 = $0.0051
      //   10.2 raw -> 11 credits (pinned draw). ~6x cheaper than the cold turn, prompt unchanged.
      const warm = await runWithCacheRead(3000, 2800);
      expect(warm.estimatedCost).toBeCloseTo(0.0051, 6);
      expect(warm.creditsUsed).toBe(11);
      expect(warm.creditsUsed).toBeLessThan(cold.creditsUsed);
    });
  });

  // `delegate_to_agent` must not be exposed to the LLM unless the user actually asked
  // for an agent. Previously the tool was auto-injected for every chat completion and
  // the model autonomously called it on benign prompts, spawning subagent runs that
  // burned millions of tokens (a "compare smartphones" prompt rolled up 17,990 credits
  // because the model self-delegated to the researcher agent).
  describe('delegate_to_agent gating', () => {
    /**
     * Captures the agentStore that ChatCompletionProcess passes into
     * ToolBuilder.buildTools so we can assert the gating decision directly.
     */
    const runWithBuildToolsSpy = async (params: {
      message: string;
      sessionAgentIds?: string[];
      allowedAgents?: string[];
    }) => {
      // vi.spyOn on a prototype is idempotent across tests: the same underlying
      // mock survives, so `mock.calls` accumulates. Clear before each invocation
      // so we read only this test's call.
      const buildToolsSpy = vi.spyOn(ToolBuilder.prototype, 'buildTools').mockReturnValue([]);
      buildToolsSpy.mockClear();
      const buildToolPromptSpy = vi.spyOn(ToolBuilder.prototype, 'buildToolPrompt').mockResolvedValue(null);
      buildToolPromptSpy.mockClear();

      mockSession.agentIds = params.sessionAgentIds ?? [];
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_m, _msgs, _opts, cb) => cb(['Hi!'])),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });
      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ChatModels.GPT4,
          type: 'text',
          name: 'GPT-4',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 200_000,
          can_stream: false,
          pricing: {},
          supportsImageVariation: false,
        },
      ]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: params.message }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: params.message });

      const body = {
        ...startQuestParams,
        message: params.message,
        tools: [],
        projectId: undefined,
        organizationId: undefined,
        ...(params.allowedAgents !== undefined ? { allowedAgents: params.allowedAgents } : {}),
      };
      await service.process({ body, logger: mockLogger });

      return buildToolsSpy.mock.calls[0]?.[0]?.agentStore;
    };

    it('does NOT expose delegate_to_agent on a benign prompt with no @mention and no attached agents', async () => {
      const agentStore = await runWithBuildToolsSpy({
        message: 'Compare the latest iPhone, Samsung Galaxy, and Google Pixel smartphones',
      });
      expect(agentStore).toBeUndefined();
    });

    it('exposes delegate_to_agent when the user @mentions an agent', async () => {
      const agentStore = await runWithBuildToolsSpy({
        message: '@researcher please look up the latest smartphone specs',
      });
      expect(agentStore).toBeDefined();
    });

    it('exposes delegate_to_agent when the session has an agent attached', async () => {
      const agentStore = await runWithBuildToolsSpy({
        message: 'Compare the smartphones',
        sessionAgentIds: ['some-agent-id'],
      });
      expect(agentStore).toBeDefined();
    });

    it('exposes delegate_to_agent when the caller passes an explicit allowedAgents allowlist', async () => {
      // Persona surfaces opt-in by passing allowedAgents even on benign-looking
      // prompts so the user can still invoke the curated agent set.
      const agentStore = await runWithBuildToolsSpy({
        message: 'Tell me about treatment options',
        allowedAgents: ['researcher'],
      });
      expect(agentStore).toBeDefined();
    });

    it('treats an empty allowedAgents allowlist as "no delegation" rather than "delegation to nothing"', async () => {
      // Pre-fix, `allowedAgents: []` would still trip the `!= null` predicate and
      // expose `delegate_to_agent` to the model, but the resulting store had zero
      // agents, so the model could only fail. Treat empty as a "no delegation"
      // signal so the tool stays suppressed.
      const agentStore = await runWithBuildToolsSpy({
        message: 'Tell me about treatment options',
        allowedAgents: [],
      });
      expect(agentStore).toBeUndefined();
    });
  });

  describe('isRequestTimeoutError', () => {
    it('should match lowercase "request timeout"', () => {
      expect(isRequestTimeoutError(new Error('Anthropic API request timeout after 60000ms'))).toBe(true);
    });

    it('should match capitalized "Request timeout"', () => {
      expect(isRequestTimeoutError(new Error('Request timeout waiting for response'))).toBe(true);
    });

    it('should not match stream timeout errors', () => {
      expect(isRequestTimeoutError(new Error('stream timeout - no data received'))).toBe(false);
    });

    it('should not match overloaded errors', () => {
      expect(isRequestTimeoutError(new Error('Anthropic API is overloaded'))).toBe(false);
    });

    it('should not match generic errors', () => {
      expect(isRequestTimeoutError(new Error('Something went wrong'))).toBe(false);
    });

    it('should not match abort errors', () => {
      expect(isRequestTimeoutError(new Error('The operation was aborted'))).toBe(false);
    });
  });

  // Gates the severity of the raw `logger.error(lastError)` dump in the fallback
  // catch: aborts log at warn so they stay out of the CloudWatch ERROR-to-LiveOps
  // alert path. Genuine failures must still return false, hitting error.
  describe('isAbortError', () => {
    it('matches AbortError by name regardless of message', () => {
      const err = new Error('socket hang up');
      err.name = 'AbortError';
      expect(isAbortError(err)).toBe(true);
    });

    it('matches SDK abort phrasings case-insensitively', () => {
      expect(isAbortError(new Error('Request aborted'))).toBe(true);
      expect(isAbortError(new Error('The operation was aborted'))).toBe(true);
    });

    it("matches the retry helper's bare Error('Aborted') (capital A)", () => {
      expect(isAbortError(new Error('Aborted'))).toBe(true);
    });

    it('does not match genuine failures', () => {
      expect(isAbortError(new Error('Anthropic API is overloaded'))).toBe(false);
      expect(isAbortError(new Error('Something went wrong'))).toBe(false);
    });

    it('does not match non-Error values', () => {
      expect(isAbortError('aborted')).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
      expect(isAbortError(null)).toBe(false);
    });
  });

  describe('request timeout error handling', () => {
    // Production retry path sleeps on real setTimeout (TIMEOUT_RETRY_DELAY_MS=2000 + jitter).
    // Fake timers keep these tests under 100ms each instead of 2-3s.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const modelInfo = {
      id: ChatModels.GPT4,
      type: 'text',
      name: 'GPT-4',
      backend: ModelBackend.OpenAI,
      max_tokens: 100,
      contextWindow: 1000,
      can_stream: false,
      pricing: {},
      supportsImageVariation: false,
    };

    function setupTimeoutMocks() {
      mockedGetAvailableModels.mockResolvedValue([modelInfo]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });
      // Timeout errors are retryable
      mockedShouldTriggerFallback.mockReturnValue(true);
      // But NOT overloaded (shouldn't get 3 retries)
      mockedIsOverloadedError.mockReturnValue(false);
      // No fallback model available
      mockedGetLlmWithFallback.mockResolvedValue(null);
    }

    it('should retry once on request timeout then show friendly error when fallback unavailable', async () => {
      setupTimeoutMocks();

      let callCount = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          callCount++;
          throw new Error('Anthropic API request timeout after 60000ms - no streaming response received');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      // Should have retried once (2 calls total: original + 1 timeout retry)
      expect(callCount).toBe(2);

      // Quest should be saved with friendly error message
      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          reply: 'The AI service is currently experiencing high demand. Please try again in a few minutes.',
          type: 'error',
          status: 'done',
        })
      );
    });

    it('should succeed on timeout retry if second attempt works', async () => {
      setupTimeoutMocks();

      let callCount = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi
          .fn()
          .mockImplementation(
            async (_model: unknown, _messages: unknown, _opts: unknown, cb: (chunks: string[]) => Promise<void>) => {
              callCount++;
              if (callCount === 1) {
                throw new Error('Anthropic API request timeout after 60000ms');
              }
              // Second attempt succeeds
              await cb(['Hello from retry!']);
            }
          ),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      expect(callCount).toBe(2);

      // Quest should be saved with the successful reply
      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: ['Hello from retry!'],
          status: 'done',
          type: 'message',
        })
      );
    });

    it('should send status update during timeout retry', async () => {
      setupTimeoutMocks();

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          throw new Error('Anthropic API request timeout after 60000ms');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      // Should have sent a "retrying" status update
      expect(service.sendStatusUpdate).toHaveBeenCalledWith(
        expect.anything(),
        'AI service is slow, retrying...',
        expect.objectContaining({ statusAt: expect.any(Date) })
      );
    });

    it('should catch stream timeout in outer error handler with friendly message', async () => {
      setupTimeoutMocks();
      // Make shouldTriggerFallback return false so it throws immediately (non-retryable),
      // hitting the outer catch directly
      mockedShouldTriggerFallback.mockReturnValue(false);

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          throw new Error('stream timeout - idle for too long, overloaded backend');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await service.process({ body, logger: mockLogger });

      // Should save with friendly error, not raw message
      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          reply: 'The AI service is currently experiencing high demand. Please try again in a few minutes.',
          type: 'error',
          status: 'done',
        })
      );
    });
  });

  describe('isStreamIdleTimeoutError', () => {
    it('should match lowercase "stream timeout"', () => {
      expect(
        isStreamIdleTimeoutError(new Error('Anthropic API stream timeout - no response received within 90 seconds.'))
      ).toBe(true);
    });

    it('should match capitalized "Stream timeout"', () => {
      expect(isStreamIdleTimeoutError(new Error('Stream timeout waiting for response'))).toBe(true);
    });

    it('should not match request timeout errors', () => {
      expect(isStreamIdleTimeoutError(new Error('Anthropic API request timeout after 60000ms'))).toBe(false);
    });

    it('should not match overloaded errors', () => {
      expect(isStreamIdleTimeoutError(new Error('Anthropic API is overloaded'))).toBe(false);
    });

    it('should not match generic errors', () => {
      expect(isStreamIdleTimeoutError(new Error('Something went wrong'))).toBe(false);
    });
  });

  describe('stream idle timeout error handling', () => {
    // Production retry path sleeps on real setTimeout (STREAM_IDLE_RETRY_DELAY_MS=3000 + jitter).
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const modelInfo = {
      id: ChatModels.GPT4,
      type: 'text',
      name: 'GPT-4',
      backend: ModelBackend.OpenAI,
      max_tokens: 100,
      contextWindow: 1000,
      can_stream: false,
      pricing: {},
      supportsImageVariation: false,
    };

    function setupStreamIdleTimeoutMocks() {
      mockedGetAvailableModels.mockResolvedValue([modelInfo]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });
      mockedShouldTriggerFallback.mockReturnValue(true);
      mockedIsOverloadedError.mockReturnValue(false);
      mockedGetLlmWithFallback.mockResolvedValue(null);
    }

    it('should retry once on stream idle timeout then show friendly error when fallback unavailable', async () => {
      setupStreamIdleTimeoutMocks();

      let callCount = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          callCount++;
          throw new Error(
            'Anthropic API stream timeout - no response received within 90 seconds. The model may be overloaded.'
          );
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      // Should have retried once (2 calls total: original + 1 stream idle timeout retry)
      expect(callCount).toBe(2);

      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          reply: 'The AI service is currently experiencing high demand. Please try again in a few minutes.',
          type: 'error',
          status: 'done',
        })
      );
    });

    it('should succeed on stream idle timeout retry if second attempt works', async () => {
      setupStreamIdleTimeoutMocks();

      let callCount = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi
          .fn()
          .mockImplementation(
            async (_model: unknown, _messages: unknown, _opts: unknown, cb: (chunks: string[]) => Promise<void>) => {
              callCount++;
              if (callCount === 1) {
                throw new Error('Anthropic API stream timeout - no response received within 90 seconds.');
              }
              await cb(['Hello from stream retry!']);
            }
          ),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      expect(callCount).toBe(2);

      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: ['Hello from stream retry!'],
          status: 'done',
          type: 'message',
        })
      );
    });

    it('should send status update during stream idle timeout retry', async () => {
      setupStreamIdleTimeoutMocks();

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          throw new Error('Anthropic API stream timeout - no response received within 90 seconds.');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      expect(service.sendStatusUpdate).toHaveBeenCalledWith(
        expect.anything(),
        'AI service is slow, retrying...',
        expect.objectContaining({ statusAt: expect.any(Date) })
      );
    });

    it('should not retry stream idle timeout a second time', async () => {
      setupStreamIdleTimeoutMocks();

      let callCount = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          callCount++;
          throw new Error('Anthropic API stream timeout - no response received within 90 seconds.');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await runWithFakeTimers(service.process({ body, logger: mockLogger }));

      // Only 2 attempts: original + 1 retry (not 3)
      expect(callCount).toBe(2);
    });
  });
});

describe('addPairedTool', () => {
  it('appends the paired tool when the trigger is present and the pair is missing', () => {
    expect(addPairedTool(['search_knowledge_base'], 'search_knowledge_base', 'retrieve_knowledge_content')).toEqual([
      'search_knowledge_base',
      'retrieve_knowledge_content',
    ]);
  });

  it('does not duplicate the paired tool when both are already enabled', () => {
    const input = ['search_knowledge_base', 'retrieve_knowledge_content'];
    expect(addPairedTool(input, 'search_knowledge_base', 'retrieve_knowledge_content')).toEqual([
      'search_knowledge_base',
      'retrieve_knowledge_content',
    ]);
  });

  it('returns a copy unchanged when the trigger is not present', () => {
    const input = ['web_search'];
    const result = addPairedTool(input, 'search_knowledge_base', 'retrieve_knowledge_content');
    expect(result).toEqual(['web_search']);
    // Ensure we did not mutate the input array.
    expect(result).not.toBe(input);
  });

  it('handles the image_generation → edit_image pair (regression for prior behavior)', () => {
    expect(addPairedTool(['image_generation'], 'image_generation', 'edit_image')).toEqual([
      'image_generation',
      'edit_image',
    ]);
  });
});
