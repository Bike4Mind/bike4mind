import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompletionProcess,
  addPairedTool,
  computeSettlementDelta,
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

    // Settlement bills from the provider-reported usage when present (the true
    // COGS basis, matching the cliCompletions path). The local tokenizer count
    // remains the pre-reservation estimate and the fallback when the provider
    // omits usage; provider counts also land in actualInputTokens/-OutputTokens.
    it('settles on provider-reported usage, not the local tokenizer estimate', async () => {
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

      // Billing math uses the PROVIDER counts:
      //   100 * 10/1M + 50 * 30/1M = $0.001 + $0.0015 = $0.0025
      //   0.0025 * 2000 = 5 credits (whole number - no rounding involved)
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.0025, 6);
      expect(tokenUsage.creditsUsed).toBe(5);
      expect(tokenUsage.totalTokens).toBe(localInputTokens + localOutputTokens);

      // Provider counts recorded; with provider-basis settlement they ARE the billing basis.
      expect(tokenUsage.actualInputTokens).toBe(apiInputTokens);
      expect(tokenUsage.actualOutputTokens).toBe(apiOutputTokens);
      expect(tokenUsage.settledBasis).toBe('provider');
    });

    // Idempotency guard for a cross-model failover (issue #15): the failed primary
    // attempt streamed partial output AND provider usage before erroring. The loop must
    // settle on ONLY the successful fallback attempt's usage (the per-attempt reset at
    // the top of the loop discards the failed counts) and stream ONLY the fallback's
    // reply - no double-bill, no duplicated partial output on the server side.
    it('settles a failover on the fallback attempt usage only, discarding the failed attempt', async () => {
      const primaryInputTokens = 999; // failed attempt - must NOT be billed
      const primaryOutputTokens = 999;
      const fallbackInputTokens = 100; // successful attempt - the sole billing basis
      const fallbackOutputTokens = 50;

      // Production populates promptMeta.model during prompt assembly (before the loop);
      // the fallback branch rewrites it, so seed it as that precondition.
      mockQuest.promptMeta.model = { name: ChatModels.GPT4, backend: ModelBackend.OpenAI };

      mockedCalculateTotalTokenLength.mockResolvedValue(80);
      mockTokenizer.countTokens.mockResolvedValue(40);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      // Retryable, non-overloaded, non-timeout error so the loop routes to the
      // cross-model fallback block rather than a same-model retry.
      mockedShouldTriggerFallback.mockReturnValue(true);
      mockedIsOverloadedError.mockReturnValue(false);

      // Primary streams partial output + usage, then fails.
      let primaryCalls = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          primaryCalls++;
          await cb(['partial from primary'], {
            inputTokens: primaryInputTokens,
            outputTokens: primaryOutputTokens,
          });
          throw new Error('ServiceUnavailableException: Bedrock is unable to process your request');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      // Fallback model + backend the loop switches to.
      const fallbackModel = {
        id: 'claude-opus-4-8',
        type: 'text' as const,
        name: 'Claude Opus 4.8',
        backend: ModelBackend.Anthropic,
        max_tokens: 100,
        contextWindow: 200_000,
        can_stream: true,
        pricing: { 200000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
        supportsImageVariation: false,
      };
      let fallbackCalls = 0;
      const fallbackBackend = {
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          fallbackCalls++;
          await cb(['Hello from fallback'], {
            inputTokens: fallbackInputTokens,
            outputTokens: fallbackOutputTokens,
          });
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: 'claude-opus-4-8',
      };
      mockedGetLlmWithFallback.mockResolvedValue({ model: fallbackModel, backend: fallbackBackend, attempt: 1 } as any);

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

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await service.process({ body, logger: mockLogger });

      // Exactly one primary attempt and one fallback attempt.
      expect(primaryCalls).toBe(1);
      expect(fallbackCalls).toBe(1);

      // Only the fallback attempt's reply survives (server-side streaming state was reset).
      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: ['Hello from fallback'],
          status: 'done',
          type: 'message',
          fallbackInfo: expect.objectContaining({ fallbackModel: 'claude-opus-4-8' }),
        })
      );

      // Settlement bills the fallback attempt's provider usage only - the failed
      // primary's 999/999 was discarded by the per-attempt reset (no double-bill).
      const updateCall = mockDb.quests.update.mock.calls.find(
        ([arg]: [any]) => arg?.promptMeta?.tokenUsage?.estimatedCost !== undefined
      );
      expect(updateCall).toBeDefined();
      const tokenUsage = updateCall[0].promptMeta.tokenUsage;
      expect(tokenUsage.actualInputTokens).toBe(fallbackInputTokens);
      expect(tokenUsage.actualOutputTokens).toBe(fallbackOutputTokens);
    });

    // Adapters coerce missing usage to zero (e.g. DeepSeek and Llama-on-Bedrock
    // streaming never populate usage), so {0,0} means "provider reported nothing",
    // not "the call was free". Settlement must fall back to the local estimate.
    it('falls back to the local estimate when the provider reports zero usage', async () => {
      mockedCalculateTotalTokenLength.mockResolvedValue(80);
      mockTokenizer.countTokens.mockResolvedValue(40);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          await cb(['Hi!'], { inputTokens: 0, outputTokens: 0 });
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
      expect(updateCall).toBeDefined();
      const tokenUsage = updateCall[0].promptMeta.tokenUsage;

      // Local basis (80 in, 40 out at $10/$30 per 1M): $0.002 -> 4 credits, not free.
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.002, 6);
      expect(tokenUsage.creditsUsed).toBe(4);
      expect(tokenUsage.settledBasis).toBe('local');
    });

    // Partial provider usage (cache read reported without input/output counts) also
    // falls back to the local path, where the cache-read discount caps at the local
    // input so a huge provider cache count can never produce a negative cost.
    it('caps the fallback cache-read discount at the local input on partial provider usage', async () => {
      mockedCalculateTotalTokenLength.mockResolvedValue(80);
      mockTokenizer.countTokens.mockResolvedValue(40);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          await cb(['Hi!'], { cacheReadInputTokens: 3000 });
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
      expect(updateCall).toBeDefined();
      const tokenUsage = updateCall[0].promptMeta.tokenUsage;

      // cache_read (3000) caps at local input (80); credited input = 80 - 80*0.9 = 8.
      //   8 * 10/1M + 40 * 30/1M = $0.00128; 2.56 raw -> 3 credits (pinned draw). Never negative.
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.00128, 6);
      expect(tokenUsage.creditsUsed).toBe(3);
      expect(tokenUsage.settledBasis).toBe('local');
    });

    // When the provider omits usage entirely, settlement falls back to the local
    // tokenizer estimate, byte-for-byte the pre-provider-basis behavior.
    it('falls back to the local estimate when the provider omits usage', async () => {
      mockedCalculateTotalTokenLength.mockResolvedValue(80);
      mockTokenizer.countTokens.mockResolvedValue(40);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          await cb(['Hi!']); // no usage info
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
      expect(updateCall).toBeDefined();
      const tokenUsage = updateCall[0].promptMeta.tokenUsage;

      // Local basis: 80 * 10/1M + 40 * 30/1M = $0.002; whole 4.0 raw -> 4 credits.
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.002, 6);
      expect(tokenUsage.creditsUsed).toBe(4);
      expect(tokenUsage.actualInputTokens).toBeUndefined();
      expect(tokenUsage.actualOutputTokens).toBeUndefined();
      expect(tokenUsage.settledBasis).toBe('local');
    });

    // With prompt caching the provider reports the cached part of the prompt as
    // cache_read / cache_creation and shrinks its own `input_tokens` to the uncached
    // tail. On the provider basis there is no double-count: the four components are
    // the provider's own disjoint accounting of one prompt, each billed at its rate
    // (read 0.1x input, write 1.25x input unless the model overrides). This matches
    // cliCompletions and the provider invoice.
    it('bills provider cache reads and writes at their per-model rates', async () => {
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

      // Provider basis, all four components at their rates:
      //   input    2 * 10/1M            = $0.00002
      //   output  14 * 30/1M            = $0.00042
      //   read  3000 * 10/1M * 0.1      = $0.003
      //   write 5000 * 10/1M * 1.25     = $0.0625
      //   total $0.06594; 131.88 raw -> 132 credits (pinned draw).
      expect(tokenUsage.estimatedCost).toBeCloseTo(0.06594, 6);
      expect(tokenUsage.creditsUsed).toBe(132);
      // Provider-reported cache read recorded as billed (no local cap on this basis).
      expect(tokenUsage.cacheReadInputTokens).toBe(3000);
    });

    // A cold turn (provider reports the full prompt as fresh input) and a warm
    // follow-up (most of it served from cache) on the provider basis: the warm
    // turn is far cheaper, and the local count is ignored on both (set to a
    // deliberately wrong 9999 to prove it).
    it('bills the cold turn in full and the warm cache-read turn far cheaper, ignoring the local count', async () => {
      const localOutputTokens = 10;
      mockTokenizer.countTokens.mockResolvedValue(localOutputTokens);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      // Pin the settlement draw: rng()=0 rounds up whenever a fraction exists,
      // making the stochastic charge a deterministic ceil for assertions.
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      const runWithProviderUsage = async (apiInputTokens: number, cacheReadInputTokens?: number) => {
        mockDb.quests.update.mockClear();
        mockedCalculateTotalTokenLength.mockResolvedValue(9999);
        mockedGetLlmByModel.mockReturnValue({
          complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
            await cb(['Hi!'], { inputTokens: apiInputTokens, outputTokens: 10, cacheReadInputTokens });
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

      // Cold turn: provider reports the full 3000-token prompt as fresh input.
      //   3000 * 10/1M + 10 * 30/1M = $0.0300 + $0.0003 = $0.0303; 60.6 raw -> 61 credits (pinned draw).
      const cold = await runWithProviderUsage(3000, undefined);
      expect(cold.estimatedCost).toBeCloseTo(0.0303, 6);
      expect(cold.creditsUsed).toBe(61);

      // Warm turn: 2800 of the prompt served from cache, 200 fresh.
      //   200 * 10/1M + 10 * 30/1M + 2800 * 10/1M * 0.1 = $0.002 + $0.0003 + $0.0028
      //   = $0.0051; 10.2 raw -> 11 credits (pinned draw). ~6x cheaper than the cold turn.
      const warm = await runWithProviderUsage(200, 2800);
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

describe('computeSettlementDelta (zero-balance shortfall clamp)', () => {
  it('refunds the excess on over-reservation', () => {
    expect(computeSettlementDelta(100, 60, 500)).toEqual({ delta: 40, writtenOffCredits: 0 });
  });

  it('is a no-op on exact settlement', () => {
    expect(computeSettlementDelta(100, 100, 500)).toEqual({ delta: 0, writtenOffCredits: 0 });
  });

  it('charges a shortfall the balance can cover in full', () => {
    expect(computeSettlementDelta(100, 130, 500)).toEqual({ delta: -30, writtenOffCredits: 0 });
  });

  it('clamps the shortfall to the balance and reports the write-off', () => {
    expect(computeSettlementDelta(100, 130, 10)).toEqual({ delta: -10, writtenOffCredits: 20 });
  });

  it('writes off the whole shortfall at zero balance', () => {
    expect(computeSettlementDelta(100, 130, 0)).toEqual({ delta: 0, writtenOffCredits: 30 });
  });

  it('treats a negative balance snapshot as zero', () => {
    expect(computeSettlementDelta(100, 130, -50)).toEqual({ delta: 0, writtenOffCredits: 30 });
  });
});
