import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompletionProcess,
  addPairedTool,
  resolveEnabledTools,
  shouldDeferCorpusToRetrieval,
  attachmentHasIndexedContent,
  computeSettlementDelta,
  clampFraction,
  dropOldestHistoryTurn,
  isAbortError,
  isRequestTimeoutError,
  isStreamIdleTimeoutError,
  FORCE_FALLBACK_TEST_MARKER,
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
  getSettingsValue,
} from '@bike4mind/utils';
import type { RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import { getLlmByModel, getAvailableModels } from '@bike4mind/llm-adapters';
import {
  ChatModels,
  ImageModels,
  ModelBackend,
  usdToCredits as realUsdToCredits,
  usdToCreditsStochastic as realUsdToCreditsStochastic,
  type IMessage,
} from '@bike4mind/common';
import { ToolBuilder } from './tools/ToolBuilder';
import { SYSTEM_PROMPT_PRIORITY } from './systemPromptSources';
import { SkillsFeature } from './features/SkillsFeature';
import type { ISkill } from '@bike4mind/common';
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
vi.mock('@bike4mind/utils', async importOriginal => ({
  // The context-budget helpers are pure arithmetic the assembly path reads directly, so they keep
  // their real implementations - stubbing them would make every budget figure below undefined and
  // silently disable the guards that depend on a real window.
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
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
  getProviderFromModel: vi.fn().mockReturnValue('openai'),
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
  // Consumed by resolveToolAvailability (toolAvailability.ts), threaded through
  // ChatCompletionProcess into ToolBuilder.buildTools - default to "not configured" so
  // resolveToolAvailability computes real (all-false) values instead of hitting its
  // outer catch, which would silently return {} and mask a wiring regression.
  getOpenWeatherKey: vi.fn().mockResolvedValue(undefined),
  getWolframAlphaKey: vi.fn().mockResolvedValue(undefined),
  getFmpApiKey: vi.fn().mockResolvedValue(undefined),
  getFirecrawlConfig: vi.fn().mockResolvedValue({}),
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
const mockedGetSettingsValue = vi.mocked(getSettingsValue);
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

  describe('userHasAccessibleKnowledgeLake (offering signal)', () => {
    it('memoizes a NEGATIVE result - one lookup per turn, not one per call', async () => {
      // The `=== undefined` sentinel is what makes a false result stick. A falsy check would
      // re-run the DB lookup every turn for every caller who has no lake - the common case.
      const findLakes = vi.fn().mockResolvedValue([]);
      (service as any).accessibleDataLakeAccessMemo = undefined;
      (service as any).db = { dataLakes: { findActiveByUserTagsAndEntitlements: findLakes } };
      (service as any).getEntitlements = vi.fn().mockResolvedValue([]);
      (service as any).entitlementsResolved = false;
      (service as any).entitlementKeys = [];

      expect(await service.userHasAccessibleKnowledgeLake()).toBe(false);
      expect(await service.userHasAccessibleKnowledgeLake()).toBe(false);
      expect(findLakes).toHaveBeenCalledTimes(1);
    });

    it('fails SAFE to false and warns when the lookup throws - never breaks the turn', async () => {
      (service as any).accessibleDataLakeAccessMemo = undefined;
      // No db at all: the access resolver dereferences `db.dataLakes` and throws.
      (service as any).db = undefined;
      (service as any).logger = { warn: vi.fn() };

      await expect(service.userHasAccessibleKnowledgeLake()).resolves.toBe(false);
      expect((service as any).logger.warn).toHaveBeenCalled();
    });
  });

  describe('resolveCorpusInlinePlan (defer only the tool-retrievable corpus subset)', () => {
    // The suite mocks @bike4mind/utils wholesale (getSettingsValue -> vi.fn() -> undefined). Restore
    // the production-equivalent numeric coercion so the threshold read behaves realistically here.
    beforeEach(() => {
      mockedGetSettingsValue.mockImplementation(((key: string, settings: Record<string, string>) => {
        const v = settings?.[key];
        if (v === undefined) return undefined;
        // Only the threshold is numeric; other keys (e.g. defaultEmbeddingModel) stay strings.
        return key === 'CorpusRetrievalMinInlineTokensPerDoc' ? Number(v) : v;
      }) as typeof getSettingsValue);
    });
    afterEach(() => {
      mockedGetSettingsValue.mockReset();
    });

    // Helper: partition knowledge ids into deferred vs inlined for a given lake/threshold setup.
    const runPlan = async (opts: {
      files: Array<{
        id: string;
        tags: Array<{ name: string }>;
        chunkCount?: number;
        vectorizedChunkCount?: number;
        embeddingModel?: string;
        fileName?: string;
        vectorized?: boolean;
        deletedAt?: Date;
        archivedAt?: Date;
      }>;
      dataLakeTags: string[];
      threshold: string | undefined;
      attachedFileTokenBudget: number;
      skipAutoOffers?: boolean;
      knowledgeSearchDisabled?: boolean;
      queryEmbeddingModel?: string;
      retrievalFilter?: RetrievalExclusionOptions;
    }) => {
      // Seed the per-turn access memo directly (getAccessibleDataLakeAccess returns it when set),
      // so the plan uses these tags without exercising the DB-backed resolver.
      (service as any).accessibleDataLakeAccessMemo = {
        dataLakeTags: opts.dataLakeTags,
        dataLakeTagPrefixes: [],
        scopedTagPrefixes: [],
      };
      (service as any).getScopeFilter = vi.fn().mockReturnValue({});
      (service as any).db = { fabfiles: { getAccessibleFiles: vi.fn().mockResolvedValue(opts.files) } };
      return (service as any).resolveCorpusInlinePlan({
        sessionKnowledgeIds: opts.files.map(f => f.id),
        attachedFileTokenBudget: opts.attachedFileTokenBudget,
        skipAutoOffers: opts.skipAutoOffers ?? false,
        knowledgeSearchDisabled: opts.knowledgeSearchDisabled ?? false,
        retrievalFilter: opts.retrievalFilter ?? {},
        defaultAdminSettings: {
          ...(opts.threshold ? { CorpusRetrievalMinInlineTokensPerDoc: opts.threshold } : {}),
          // The query embedding model; a doc is retrievable only if embedded under the same one.
          // Defaults to the model the fixtures embed under ('model-A') unless a test overrides it.
          ...(opts.queryEmbeddingModel === undefined
            ? { defaultEmbeddingModel: 'model-A' }
            : { defaultEmbeddingModel: opts.queryEmbeddingModel }),
        },
      });
    };

    // Retrievable-by-default fixtures: fully vectorized and embedded under the query model ('model-A').
    // Pass `over` to make an unvectorized / wrong-model / partially-vectorized variant.
    const lakeFiles = (n: number, tag = 'datalake:corpus', over: Record<string, unknown> = {}) =>
      Array.from({ length: n }, (_, i) => ({
        id: `k${i}`,
        tags: [{ name: tag }],
        chunkCount: 2,
        vectorizedChunkCount: 2,
        embeddingModel: 'model-A',
        fileName: `k${i}.md`,
        vectorized: true,
        ...over,
      }));

    it('defers the whole corpus when every doc is lake-tagged and the split goes shallow', async () => {
      const plan = await runPlan({
        files: lakeFiles(40),
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000, // 4000/40 = 100 < 500
      });
      expect(plan.deferredToRetrieval).toBe(true);
      expect(plan.deferredKnowledgeIds).toHaveLength(40);
      expect(plan.retrievableCount).toBe(40);
    });

    it('excludes non-lake-tagged attachments from the deferred set (core regression guard)', async () => {
      // The non-lake fixtures carry the fully-retrievable shape so the TAG is the only thing that
      // differs. Given bare `{id, tags}` they were already excluded by the vectorization and
      // embedding-model conjuncts, and this test passed with `lakeTagged &&` deleted from the gate.
      const files = [
        ...lakeFiles(30),
        ...lakeFiles(1, 'notes', { id: 'personal1' }),
        ...lakeFiles(1, 'datalake:corpus', { id: 'personal2', tags: [] }),
      ];
      const plan = await runPlan({
        files,
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000, // 4000/30 = 133 < 500
      });
      expect(plan.deferredToRetrieval).toBe(true);
      expect(plan.retrievableCount).toBe(30);
      expect(plan.deferredKnowledgeIds).toHaveLength(30);
      expect(plan.deferredKnowledgeIds).not.toContain('personal1');
      expect(plan.deferredKnowledgeIds).not.toContain('personal2');
    });

    // The plan and the knowledge tool must agree on reachability. Both cases below are docs that
    // pass every OTHER gate (lake-tagged, chunk counts complete, matching embedding model) yet the
    // tool would refuse to return, so deferring them would strand their content silently.
    it('excludes a doc the session retrieval-exclusion MARKER hides from the tool', async () => {
      const files = [
        ...lakeFiles(39),
        ...lakeFiles(1, 'datalake:corpus', { id: 'marked', fileName: 'MARK - contract.pdf' }),
      ];
      const plan = await runPlan({
        files,
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000, // 4000/39 = 102 < 500, so deferral still fires
        retrievalFilter: { excludeFilenameMarkers: ['mark'] },
      });
      expect(plan.deferredToRetrieval).toBe(true);
      expect(plan.retrievableCount).toBe(39);
      expect(plan.deferredKnowledgeIds).not.toContain('marked');

      // Positive control: identical corpus, filter removed. Proves the assertion above is the
      // filter's doing and not some other gate quietly excluding the fixture.
      const unfiltered = await runPlan({
        files,
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000,
      });
      expect(unfiltered.retrievableCount).toBe(40);
      expect(unfiltered.deferredKnowledgeIds).toContain('marked');
    });

    it('excludes an unflagged doc under retrievalVectorizedOnly, which the chunk-count gate misses', async () => {
      // `vectorizedOnly` reads the `vectorized` BOOLEAN; the retrievability gate reads the chunk
      // counts. A doc with complete counts but the flag unset passes one and fails the other, so
      // this is the arm the chunk-count check does NOT subsume.
      const files = [...lakeFiles(39), ...lakeFiles(1, 'datalake:corpus', { id: 'unflagged', vectorized: false })];
      const plan = await runPlan({
        files,
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000,
        retrievalFilter: { vectorizedOnly: true },
      });
      expect(plan.retrievableCount).toBe(39);
      expect(plan.deferredKnowledgeIds).not.toContain('unflagged');
    });

    it('excludes soft-deleted and archived docs, which the tool also refuses to return', async () => {
      const files = [
        ...lakeFiles(38),
        ...lakeFiles(1, 'datalake:corpus', { id: 'gone', deletedAt: new Date() }),
        ...lakeFiles(1, 'datalake:corpus', { id: 'shelved', archivedAt: new Date() }),
      ];
      const plan = await runPlan({
        files,
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000,
      });
      expect(plan.retrievableCount).toBe(38);
      expect(plan.deferredKnowledgeIds).not.toContain('gone');
      expect(plan.deferredKnowledgeIds).not.toContain('shelved');
    });

    it('defers nothing when the caller has no accessible lake (nothing is retrievable)', async () => {
      const plan = await runPlan({
        files: lakeFiles(40),
        dataLakeTags: [],
        threshold: '500',
        attachedFileTokenBudget: 4000,
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.deferredKnowledgeIds).toHaveLength(0);
    });

    it('excludes lake-tagged but UNVECTORIZED docs - the search tool cannot surface them (#1411 gap)', async () => {
      const vectorized = lakeFiles(30); // k0..k29, fully vectorized under the query model
      const unvectorized = lakeFiles(10, 'datalake:corpus', { chunkCount: 0, vectorizedChunkCount: 0 }).map(f => ({
        ...f,
        id: `u${f.id}`,
      }));
      const plan = await runPlan({
        files: [...vectorized, ...unvectorized],
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000, // 4000/30 = 133 < 500
      });
      expect(plan.deferredToRetrieval).toBe(true);
      expect(plan.retrievableCount).toBe(30); // only the vectorized docs count
      expect(plan.deferredKnowledgeIds).toHaveLength(30);
      expect(plan.deferredKnowledgeIds.some((id: string) => id.startsWith('u'))).toBe(false);
    });

    it('excludes a partially-vectorized doc (vectorizedChunkCount < chunkCount)', async () => {
      const plan = await runPlan({
        files: lakeFiles(40, 'datalake:corpus', { chunkCount: 4, vectorizedChunkCount: 2 }),
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000,
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.retrievableCount).toBe(0);
    });

    it('excludes lake-tagged docs embedded under a DIFFERENT model than the query', async () => {
      const plan = await runPlan({
        files: lakeFiles(40, 'datalake:corpus', { embeddingModel: 'model-B' }),
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000,
        queryEmbeddingModel: 'model-A',
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.retrievableCount).toBe(0);
    });

    it('defers nothing when the query embedding model is unresolvable (semantic arm cannot run)', async () => {
      const plan = await runPlan({
        files: lakeFiles(40), // vectorized under 'model-A', but the query has no model
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000,
        queryEmbeddingModel: '',
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.retrievableCount).toBe(0);
    });

    it('keeps a small corpus inlined (per-doc share stays above the floor)', async () => {
      const plan = await runPlan({
        files: lakeFiles(3),
        dataLakeTags: ['datalake:corpus'],
        threshold: '500',
        attachedFileTokenBudget: 4000, // 4000/3 = 1333 >= 500
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.deferredKnowledgeIds).toHaveLength(0);
      expect(plan.retrievableCount).toBe(3);
    });

    it('defers nothing when the threshold is unset (feature off = today behavior)', async () => {
      const plan = await runPlan({
        files: lakeFiles(40),
        dataLakeTags: ['datalake:corpus'],
        threshold: undefined,
        attachedFileTokenBudget: 4000,
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.deferredKnowledgeIds).toHaveLength(0);
    });

    it('defers nothing under promptMode (skipAutoOffers) and never reads files', async () => {
      (service as any).accessibleDataLakeAccessMemo = undefined;
      const getAccessibleFiles = vi.fn();
      (service as any).db = { fabfiles: { getAccessibleFiles } };
      const plan = await (service as any).resolveCorpusInlinePlan({
        sessionKnowledgeIds: ['k0', 'k1'],
        attachedFileTokenBudget: 4000,
        skipAutoOffers: true,
        defaultAdminSettings: { CorpusRetrievalMinInlineTokensPerDoc: '500' },
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.deferredKnowledgeIds).toHaveLength(0);
      expect(getAccessibleFiles).not.toHaveBeenCalled();
    });

    it('defers nothing when the session denylist forbids the knowledge-search tool', async () => {
      // `session.disabledTools` is applied to the built tool list AFTER this plan runs, so a
      // corpus deferred here would be handed to a tool that is then stripped - losing it outright.
      // Seed the lake memo and a real file set: without them the no-lake / empty-corpus early
      // returns catch this case first and the test passes with the denylist guard DELETED.
      const files = lakeFiles(40);
      (service as any).accessibleDataLakeAccessMemo = {
        dataLakeTags: ['datalake:corpus'],
        dataLakeTagPrefixes: [],
        scopedTagPrefixes: [],
      };
      (service as any).getScopeFilter = vi.fn().mockReturnValue({});
      const getAccessibleFiles = vi.fn().mockResolvedValue(files);
      (service as any).db = { fabfiles: { getAccessibleFiles } };
      const plan = await (service as any).resolveCorpusInlinePlan({
        sessionKnowledgeIds: files.map(f => f.id),
        attachedFileTokenBudget: 4000, // 4000/40 = 100 < 500: would defer all 40 but for the guard
        skipAutoOffers: false,
        knowledgeSearchDisabled: true,
        retrievalFilter: {},
        defaultAdminSettings: { CorpusRetrievalMinInlineTokensPerDoc: '500', defaultEmbeddingModel: 'model-A' },
      });
      expect(plan.deferredToRetrieval).toBe(false);
      expect(plan.deferredKnowledgeIds).toHaveLength(0);
      expect(getAccessibleFiles).not.toHaveBeenCalled();
    });

    it('fails SAFE (inline all) and warns when the file read throws', async () => {
      (service as any).accessibleDataLakeAccessMemo = {
        dataLakeTags: ['datalake:corpus'],
        dataLakeTagPrefixes: [],
        scopedTagPrefixes: [],
      };
      (service as any).getScopeFilter = vi.fn().mockReturnValue({});
      (service as any).db = { fabfiles: { getAccessibleFiles: vi.fn().mockRejectedValue(new Error('db down')) } };
      (service as any).logger = { warn: vi.fn() };
      const plan = await (service as any).resolveCorpusInlinePlan({
        sessionKnowledgeIds: ['k0'],
        attachedFileTokenBudget: 4000,
        skipAutoOffers: false,
        defaultAdminSettings: { CorpusRetrievalMinInlineTokensPerDoc: '500' },
      });
      expect(plan.deferredKnowledgeIds).toHaveLength(0);
      expect((service as any).logger.warn).toHaveBeenCalled();
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

    // The promptMode wiring, asserted at the boundary the prompt actually crosses: the
    // context/system array handed to buildAndSortMessages. The two cases form a discriminating
    // pair - if the filter were unwired, the raw case would still carry the date context and the
    // pair could not both pass. This is the "provably zero injectors" claim for API mode raw.
    describe('promptMode', () => {
      const mockTextModel = () => {
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
      };

      it('hands the full system stack to the builder when no mode is set', async () => {
        mockTextModel();
        const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };

        await expect(service.process({ body, logger: mockLogger })).resolves.not.toThrow();

        const [, contextAndSystemMessages, , , , , , , options] = mockedBuildAndSortMessages.mock.calls[0];
        expect(
          contextAndSystemMessages.some(m => typeof m.content === 'string' && m.content.startsWith('Current date:'))
        ).toBe(true);
        expect(options).toEqual(expect.objectContaining({ skipAdminPromptTemplates: false }));
        // The per-source breakdown persists on the quest unconditionally - not only when enhanced
        // telemetry is enabled - so the API layer can report which prompts fed a completion.
        const savedQuest = vi.mocked(mockDb.quests.update).mock.calls.at(-1)?.[0] as {
          promptMeta?: { context?: { systemPromptDetails?: { name: string }[] } };
        };
        expect(savedQuest.promptMeta?.context?.systemPromptDetails?.map(d => d.name)).toContain('date_time_context');
      });

      it('hands an EMPTY system stack to the builder under raw, and skips the admin templates', async () => {
        mockTextModel();
        const body = {
          ...startQuestParams,
          promptMode: 'raw' as const,
          tools: [],
          projectId: undefined,
          organizationId: undefined,
        };

        await expect(service.process({ body, logger: mockLogger })).resolves.not.toThrow();

        const [, contextAndSystemMessages, , , , , , , options] = mockedBuildAndSortMessages.mock.calls[0];
        expect(contextAndSystemMessages).toEqual([]);
        expect(options).toEqual(expect.objectContaining({ skipAdminPromptTemplates: true }));
        // The adapter appends a model-identity line to the system parameter on its own;
        // raw has to reach through and turn that off too, or "empty stack" is off by 17 tokens.
        const completeOpts = vi.mocked(mockedGetLlmByModel.mock.results[0].value.complete).mock.calls[0][2];
        expect(completeOpts.omitIdentityReminder).toBe(true);
      });

      // Auto-added tools are OUR additions, and any attached tool also pulls the provider's
      // server-side tool-use preamble into the request (observed live: an Anthropic completion
      // with only auto-added tools knew the current date on a fresh raw session). The same
      // admin user is used for both cases, so the pair discriminates on the mode alone.
      it('suppresses auto-added tools under a mode, but not for a default request', async () => {
        (service as any).user.isAdmin = true; // makes blog_draft auto-add fire on the default path
        try {
          mockTextModel();
          const base = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };

          await service.process({ body: base, logger: mockLogger });
          const defaultTools = vi.mocked(mockedGetLlmByModel.mock.results[0].value.complete).mock.calls[0][2].tools;
          expect(defaultTools?.map((t: { toolSchema: { name: string } }) => t.toolSchema.name)).toContain('blog_draft');

          mockTextModel();
          await service.process({ body: { ...base, promptMode: 'raw' as const }, logger: mockLogger });
          const rawTools = vi.mocked(mockedGetLlmByModel.mock.results[1].value.complete).mock.calls[0][2].tools;
          expect(rawTools ?? []).toEqual([]);
        } finally {
          delete (service as any).user.isAdmin;
        }
      });
    });

    // An empty message array means the input budget was non-positive - e.g. a model configured with
    // max output equal to its whole context window. The old guard was `if (!messages)`, which is
    // false for `[]`, so the empty prompt reached the model and it answered confidently from nothing.
    it('refuses to send an empty prompt when there is no input budget', async () => {
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn(),
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
      mockedBuildAndSortMessages.mockResolvedValue([]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };

      // Fails loudly with an actionable message naming the cause, rather than sending an empty prompt.
      await expect(service.process({ body, logger: mockLogger })).rejects.toThrow(/no input budget/);
    });

    // A media entry's max_tokens is a prompt-length limit, not an output budget, since these models
    // return media rather than tokens. Most rows set it equal to contextWindow; Gemini's image rows
    // set it lower. Reserving it as output left no input room, so the guard above rejected a request
    // that fits fine.
    it('does not reserve text output on an image model, whose max_tokens is not an output budget', async () => {
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_model, _messages, _opts, cb) => {
          await cb(['done']);
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ImageModels.GPT_IMAGE_1,
      });
      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ImageModels.GPT_IMAGE_1,
          type: 'image',
          name: 'GPT Image 1',
          backend: ModelBackend.OpenAI,
          max_tokens: 10000,
          contextWindow: 10000,
          can_stream: false,
          pricing: {},
          supportsImageVariation: false,
        },
      ]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'a duck on a bicycle' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'a duck on a bicycle' });

      const body = {
        ...startQuestParams,
        params: { model: ImageModels.GPT_IMAGE_1, temperature: 0.5, top_p: 1, max_tokens: 9000 },
        tools: [],
        projectId: undefined,
        organizationId: undefined,
      };

      await expect(service.process({ body, logger: mockLogger })).resolves.not.toThrow();
      // 10000 context - 1000 reserve, with no output subtracted.
      expect(mockedBuildAndSortMessages).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        9000,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
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

    // Idempotency guard for a cross-model failover: the failed primary
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

    // Bounded multi-hop traversal (provider-wide outage): primary fails, the first fallback
    // also fails, and the loop advances to a second fallback that succeeds. Each hop passes the
    // accumulated tried-models set so no model is re-selected; billing settles on the final hop
    // only; and fallbackInfo.primaryModel stays the originally-requested model (not an
    // intermediate hop), which is what the badge contrasts against.
    it('multi-hops through successive failed models, excluding tried ones, and bills the final only', async () => {
      const fallbackInputTokens = 100;
      const fallbackOutputTokens = 50;

      mockQuest.promptMeta.model = { name: ChatModels.GPT4, backend: ModelBackend.OpenAI };
      mockedCalculateTotalTokenLength.mockResolvedValue(80);
      mockTokenizer.countTokens.mockResolvedValue(40);
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedShouldTriggerFallback.mockReturnValue(true);
      mockedIsOverloadedError.mockReturnValue(false);

      // Primary (GPT4): streams partial usage that must be discarded, then fails.
      let primaryCalls = 0;
      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_m, _ms, _o, cb) => {
          primaryCalls++;
          await cb(['partial from primary'], { inputTokens: 999, outputTokens: 999 });
          throw new Error('ServiceUnavailableException: primary outage');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      // Hop 1 (claude-opus-4-8): also fails, forcing a second hop.
      let hop1Calls = 0;
      const hop1Model = {
        id: 'claude-opus-4-8',
        type: 'text' as const,
        name: 'Claude Opus 4.8',
        backend: ModelBackend.Anthropic,
        max_tokens: 100,
        contextWindow: 200_000,
        pricing: { 200000: { input: 0, output: 0 } },
        supportsImageVariation: false,
      };
      const hop1Backend = {
        complete: vi.fn().mockImplementation(async () => {
          hop1Calls++;
          throw new Error('ServiceUnavailableException: first fallback outage');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: 'claude-opus-4-8',
      };

      // Hop 2 (gpt-5): succeeds - the sole billing basis.
      let hop2Calls = 0;
      const hop2Model = {
        id: 'gpt-5',
        type: 'text' as const,
        name: 'GPT-5',
        backend: ModelBackend.OpenAI,
        max_tokens: 100,
        contextWindow: 200_000,
        pricing: { 200000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
        supportsImageVariation: false,
      };
      const hop2Backend = {
        complete: vi.fn().mockImplementation(async (_m, _ms, _o, cb) => {
          hop2Calls++;
          await cb(['Hello from the second fallback'], {
            inputTokens: fallbackInputTokens,
            outputTokens: fallbackOutputTokens,
          });
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: 'gpt-5',
      };

      // Snapshot the exclusion set on each call (cloned - the loop mutates the same Set object).
      const excludeSnapshots: Array<Set<string>> = [];
      mockedGetLlmWithFallback.mockImplementation(async (...callArgs: any[]) => {
        const opts = callArgs[5] ?? {};
        const tried: Set<string> = opts.excludeModelIds ?? new Set();
        excludeSnapshots.push(new Set(tried));
        return tried.has('claude-opus-4-8')
          ? ({ model: hop2Model, backend: hop2Backend, attempt: 1 } as any)
          : ({ model: hop1Model, backend: hop1Backend, attempt: 1 } as any);
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

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await service.process({ body, logger: mockLogger });

      // One primary + two distinct fallback hops.
      expect(primaryCalls).toBe(1);
      expect(hop1Calls).toBe(1);
      expect(hop2Calls).toBe(1);
      expect(mockedGetLlmWithFallback).toHaveBeenCalledTimes(2);

      // Exclusion accumulates: the primary is excluded from hop 1, and both the primary and the
      // hop-1 model are excluded from hop 2 (so hop 2 can never re-pick a dead model).
      expect(excludeSnapshots[0].has(ChatModels.GPT4)).toBe(true);
      expect(excludeSnapshots[1].has(ChatModels.GPT4)).toBe(true);
      expect(excludeSnapshots[1].has('claude-opus-4-8')).toBe(true);

      // Only the final hop's reply survives; fallbackInfo contrasts the final model against the
      // TRUE original (GPT4), not the intermediate hop.
      expect(mockDb.quests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          replies: ['Hello from the second fallback'],
          status: 'done',
          type: 'message',
          fallbackInfo: expect.objectContaining({ primaryModel: ChatModels.GPT4, fallbackModel: 'gpt-5' }),
        })
      );

      // Billing settles on the final hop's provider usage only - no double-bill across hops.
      const updateCall = mockDb.quests.update.mock.calls.find(
        ([arg]: [any]) => arg?.promptMeta?.tokenUsage?.estimatedCost !== undefined
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0].promptMeta.tokenUsage.actualInputTokens).toBe(fallbackInputTokens);
      expect(updateCall[0].promptMeta.tokenUsage.actualOutputTokens).toBe(fallbackOutputTokens);
    });

    // Exhaustion path + final-hop cross-provider wiring: every hop fails, so the loop runs the
    // full MAX_FALLBACK_HOPS budget and throws. Asserts the loop asks getLlmWithFallback for a
    // cross-provider (preferUntriedBackend) ONLY on the final hop, and settles as errored.
    it('exhausts the hop budget and sets preferUntriedBackend only on the final hop', async () => {
      mockQuest.promptMeta.model = { name: ChatModels.GPT4, backend: ModelBackend.OpenAI };
      mockedShouldTriggerFallback.mockReturnValue(true);
      mockedIsOverloadedError.mockReturnValue(false);

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async () => {
          throw new Error('ServiceUnavailableException: primary outage');
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      });

      // Each hop returns a distinct model whose backend also fails, so the loop keeps hopping.
      const optsSeen: Array<{ preferUntriedBackend?: boolean }> = [];
      let hopN = 0;
      mockedGetLlmWithFallback.mockImplementation(async (...callArgs: any[]) => {
        optsSeen.push(callArgs[5] ?? {});
        hopN++;
        return {
          model: {
            id: `hop-model-${hopN}`,
            type: 'text',
            name: `Hop ${hopN}`,
            backend: ModelBackend.Anthropic,
            max_tokens: 100,
            contextWindow: 200_000,
            pricing: { 200000: { input: 0, output: 0 } },
            supportsImageVariation: false,
          },
          backend: {
            complete: vi.fn().mockImplementation(async () => {
              throw new Error('ServiceUnavailableException: hop outage');
            }),
            getModelInfo: vi.fn().mockResolvedValue([]),
            currentModel: `hop-model-${hopN}`,
          },
          attempt: 1,
        } as any;
      });

      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ChatModels.GPT4,
          type: 'text',
          name: 'GPT-4',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 200_000,
          pricing: { 200000: { input: 0, output: 0 } },
          supportsImageVariation: false,
        },
      ]);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }]);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' });

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      // Total exhaustion rethrows the last error (pre-existing loop behavior); swallow it so we
      // can inspect the per-hop options the loop passed.
      await service.process({ body, logger: mockLogger }).catch(() => undefined);

      // MAX_FALLBACK_HOPS (5) hops attempted, then the budget-exhausted guard throws.
      expect(optsSeen.length).toBe(5);
      // Same-provider degradation on the earlier hops; the cross-provider guarantee only on the last.
      expect(optsSeen.slice(0, 4).every(o => o.preferUntriedBackend === false)).toBe(true);
      expect(optsSeen[4].preferUntriedBackend).toBe(true);
    });

    // Wiring test: with the E2E gate on and the marker present, the affordance simulates a
    // provider-wide Anthropic outage - it throws on every Bedrock/Anthropic-backed hop, so the
    // Bedrock primary never runs and the loop crosses to the non-Anthropic fallback (gpt-5),
    // whose hop the marker leaves alone. (isOverloadedError is stubbed false here to skip the
    // same-model overload retries; the real overload -> forceSwitch path a genuine outage takes is
    // validated end-to-end on the preview, where getLlmWithFallback is not mocked.)
    it('simulates a provider-wide Anthropic outage via the E2E marker and crosses to a live provider', async () => {
      const prevEnv = process.env.E2E_ENDPOINTS_ENABLED;
      process.env.E2E_ENDPOINTS_ENABLED = 'true';
      try {
        mockedShouldTriggerFallback.mockReturnValue(true);
        mockedIsOverloadedError.mockReturnValue(false);

        // Bedrock primary must never run - the marker throws before currentLlm.complete.
        let primaryComplete = 0;
        mockedGetLlmByModel.mockReturnValue({
          complete: vi.fn().mockImplementation(async () => {
            primaryComplete++;
          }),
          getModelInfo: vi.fn().mockResolvedValue([]),
          currentModel: 'global.anthropic.claude-opus-4-8',
        });

        // Fallback is a non-Anthropic provider, so the marker leaves its hop alone and it runs.
        let fallbackComplete = 0;
        const fallbackModel = {
          id: 'gpt-5',
          type: 'text' as const,
          name: 'GPT-5',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 200_000,
          pricing: { 200000: { input: 0, output: 0 } },
          supportsImageVariation: false,
        };
        mockedGetLlmWithFallback.mockResolvedValue({
          model: fallbackModel,
          backend: {
            complete: vi.fn().mockImplementation(async (_m, _ms, _o, cb) => {
              fallbackComplete++;
              await cb(['answer from fallback model']);
            }),
            getModelInfo: vi.fn().mockResolvedValue([]),
            currentModel: 'gpt-5',
          },
          attempt: 1,
        } as any);

        mockQuest.promptMeta.model = {
          name: 'global.anthropic.claude-opus-4-8',
          backend: ModelBackend.Bedrock,
        };
        mockedGetAvailableModels.mockResolvedValue([
          {
            id: 'global.anthropic.claude-opus-4-8',
            type: 'text',
            name: 'Claude Opus 4.8',
            backend: ModelBackend.Bedrock,
            max_tokens: 100,
            contextWindow: 200_000,
            pricing: { 200000: { input: 0, output: 0 } },
            supportsImageVariation: false,
          },
        ]);
        mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: `hi ${FORCE_FALLBACK_TEST_MARKER}` }]);
        mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
        mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'hi' });

        const body = {
          ...startQuestParams,
          params: { ...startQuestParams.params, model: 'global.anthropic.claude-opus-4-8' },
          tools: [],
          projectId: undefined,
          organizationId: undefined,
        };
        await service.process({ body, logger: mockLogger });

        expect(primaryComplete).toBe(0); // marker threw before the Bedrock primary ran
        expect(fallbackComplete).toBe(1); // the loop crossed to the non-Anthropic fallback
        expect(mockedGetLlmWithFallback).toHaveBeenCalled();
        expect(mockDb.quests.update).toHaveBeenCalledWith(
          expect.objectContaining({ replies: ['answer from fallback model'], status: 'done', type: 'message' })
        );
      } finally {
        if (prevEnv === undefined) delete process.env.E2E_ENDPOINTS_ENABLED;
        else process.env.E2E_ENDPOINTS_ENABLED = prevEnv;
      }
    });

    // The marker widens per hop, not just on the primary: it must also fire on an INTERMEDIATE
    // Anthropic-backed fallback hop (so the simulated outage spans the whole provider path) and
    // then let a subsequent non-Anthropic hop through.
    it('E2E marker fires on an intermediate Anthropic fallback hop, not only the primary', async () => {
      const prevEnv = process.env.E2E_ENDPOINTS_ENABLED;
      process.env.E2E_ENDPOINTS_ENABLED = 'true';
      try {
        mockedShouldTriggerFallback.mockReturnValue(true);
        mockedIsOverloadedError.mockReturnValue(false);

        // Bedrock primary: marker fires before it runs.
        let primaryComplete = 0;
        mockedGetLlmByModel.mockReturnValue({
          complete: vi.fn().mockImplementation(async () => {
            primaryComplete++;
          }),
          getModelInfo: vi.fn().mockResolvedValue([]),
          currentModel: 'global.anthropic.claude-opus-4-8',
        });

        // Hop 1 = Anthropic-direct (marker must fire on it too → its backend never completes).
        // Hop 2 = OpenAI (marker leaves it alone → it completes).
        let anthropicHopComplete = 0;
        let openaiHopComplete = 0;
        const mk = (id: string, backend: ModelBackend, onComplete: () => void, reply?: string) => ({
          model: {
            id,
            type: 'text' as const,
            name: id,
            backend,
            max_tokens: 100,
            contextWindow: 200_000,
            pricing: { 200000: { input: 0, output: 0 } },
            supportsImageVariation: false,
          },
          backend: {
            complete: vi.fn().mockImplementation(async (_m: any, _ms: any, _o: any, cb: any) => {
              onComplete();
              if (reply) await cb([reply]);
            }),
            getModelInfo: vi.fn().mockResolvedValue([]),
            currentModel: id,
          },
          attempt: 1,
        });
        mockedGetLlmWithFallback
          .mockResolvedValueOnce(mk('claude-opus-4-8', ModelBackend.Anthropic, () => anthropicHopComplete++) as any)
          .mockResolvedValueOnce(
            mk('gpt-5', ModelBackend.OpenAI, () => openaiHopComplete++, 'answer from cross-provider') as any
          );

        mockQuest.promptMeta.model = { name: 'global.anthropic.claude-opus-4-8', backend: ModelBackend.Bedrock };
        mockedGetAvailableModels.mockResolvedValue([
          {
            id: 'global.anthropic.claude-opus-4-8',
            type: 'text',
            name: 'Claude 4.8 Opus',
            backend: ModelBackend.Bedrock,
            max_tokens: 100,
            contextWindow: 200_000,
            pricing: { 200000: { input: 0, output: 0 } },
            supportsImageVariation: false,
          },
        ]);
        mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: `hi ${FORCE_FALLBACK_TEST_MARKER}` }]);
        mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
        mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'hi' });

        const body = {
          ...startQuestParams,
          params: { ...startQuestParams.params, model: 'global.anthropic.claude-opus-4-8' },
          tools: [],
          projectId: undefined,
          organizationId: undefined,
        };
        await service.process({ body, logger: mockLogger });

        expect(primaryComplete).toBe(0); // marker fired on the Bedrock primary
        expect(anthropicHopComplete).toBe(0); // marker ALSO fired on the intermediate Anthropic hop
        expect(openaiHopComplete).toBe(1); // the non-Anthropic hop ran for real
        expect(mockedGetLlmWithFallback).toHaveBeenCalledTimes(2);
        expect(mockDb.quests.update).toHaveBeenCalledWith(
          expect.objectContaining({ replies: ['answer from cross-provider'], status: 'done', type: 'message' })
        );
      } finally {
        if (prevEnv === undefined) delete process.env.E2E_ENDPOINTS_ENABLED;
        else process.env.E2E_ENDPOINTS_ENABLED = prevEnv;
      }
    });

    // The marker is inert without the E2E gate (production safety).
    it('ignores the fallback marker when E2E endpoints are disabled', async () => {
      const prevEnv = process.env.E2E_ENDPOINTS_ENABLED;
      delete process.env.E2E_ENDPOINTS_ENABLED;
      try {
        let primaryComplete = 0;
        mockedGetLlmByModel.mockReturnValue({
          complete: vi.fn().mockImplementation(async (_m, _ms, _o, cb) => {
            primaryComplete++;
            await cb(['normal answer']);
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
            pricing: {},
            supportsImageVariation: false,
          },
        ]);
        mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: `hi ${FORCE_FALLBACK_TEST_MARKER}` }]);
        mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}]);
        mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'hi' });

        const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
        await service.process({ body, logger: mockLogger });

        expect(primaryComplete).toBe(1); // marker ignored — primary ran normally
        expect(mockedGetLlmWithFallback).not.toHaveBeenCalled();
      } finally {
        if (prevEnv === undefined) delete process.env.E2E_ENDPOINTS_ENABLED;
        else process.env.E2E_ENDPOINTS_ENABLED = prevEnv;
      }
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

  // Proves the route branch, not just the pure predicate: the offer signal a still-chunking
  // attachment produces at the `hasAttachedKnowledge` computation inside process() (#1163).
  describe('knowledge-tool gating for a still-chunking attachment (#1163)', () => {
    const knowledgeToolDefs: Record<string, { toolSchema: { name: string; description: string; parameters: object } }> =
      {
        search_knowledge_base: {
          toolSchema: { name: 'search_knowledge_base', description: 'search', parameters: {} },
        },
        retrieve_knowledge_content: {
          toolSchema: { name: 'retrieve_knowledge_content', description: 'retrieve', parameters: {} },
        },
      };

    // Mirrors the real filter (buildSharedTools includes a tool iff its name is in enabledTools),
    // so `enabledToolsArg` below is exactly what the model would actually be offered.
    const runKnowledgeGatingCase = async (opts: {
      knowledgeIds?: string[];
      files?: Array<Partial<{ id: string; fileName: string; vectorized: boolean; chunkCount: number }>>;
      getAccessibleFilesImpl?: () => Promise<unknown>;
      dataLakeTags?: string[];
      promptMode?: 'raw';
      fabPromptMessages?: IMessage[];
    }) => {
      mockSession.knowledgeIds = opts.knowledgeIds ?? [];
      const getAccessibleFiles = opts.getAccessibleFilesImpl
        ? vi.fn().mockImplementation(opts.getAccessibleFilesImpl)
        : vi.fn().mockResolvedValue(opts.files ?? []);
      mockDb.fabfiles = { getAccessibleFiles };
      // Seed the lake-access memo directly (same pattern as the resolveCorpusInlinePlan suite)
      // so this test controls the lake signal without exercising the DB-backed resolver.
      (service as any).accessibleDataLakeAccessMemo = {
        dataLakeTags: opts.dataLakeTags ?? [],
        dataLakeTagPrefixes: [],
        scopedTagPrefixes: [],
      };
      (service as any).getScopeFilter = vi.fn().mockReturnValue({});

      if (opts.fabPromptMessages) {
        vi.spyOn(service as any, 'fabFilesToMessages').mockResolvedValue({
          promptMessages: opts.fabPromptMessages,
          convertedFabFiles: [],
        });
      }

      const buildToolsSpy = vi
        .spyOn(ToolBuilder.prototype, 'buildTools')
        .mockImplementation(
          ({ enabledTools = [] }: { enabledTools?: string[] }) =>
            enabledTools.filter(t => knowledgeToolDefs[t]).map(t => knowledgeToolDefs[t]) as any
        );
      const buildToolPromptSpy = vi.spyOn(ToolBuilder.prototype, 'buildToolPrompt').mockResolvedValue(null);

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_m: any, _msgs: any, _opts: any, cb: any) => cb(['Hi!'])),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      } as any);
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
      ] as any);
      mockedBuildAndSortMessages.mockClear();
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }] as any);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}] as any);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' } as any);

      const body = {
        ...startQuestParams,
        ...(opts.promptMode ? { promptMode: opts.promptMode } : {}),
        tools: [],
        projectId: undefined,
        organizationId: undefined,
      };

      await expect(service.process({ body, logger: mockLogger })).resolves.not.toThrow();

      // Read the recorded call BEFORE restoring - mockRestore() also clears mock.calls.
      const enabledToolsArg: string[] = (buildToolsSpy.mock.calls[0]?.[0] as any)?.enabledTools ?? [];
      const contextAndSystemMessages: IMessage[] = mockedBuildAndSortMessages.mock.calls.at(-1)?.[1] ?? [];

      buildToolsSpy.mockRestore();
      buildToolPromptSpy.mockRestore();

      return { enabledToolsArg, getAccessibleFiles, contextAndSystemMessages };
    };

    it('withholds both knowledge tools for an attachment with no readable chunk text yet', async () => {
      const { enabledToolsArg, getAccessibleFiles } = await runKnowledgeGatingCase({
        knowledgeIds: ['f1'],
        files: [{ id: 'f1', fileName: 'f1.pdf', vectorized: false, chunkCount: 0 }],
      });
      expect(enabledToolsArg).not.toContain('search_knowledge_base');
      expect(enabledToolsArg).not.toContain('retrieve_knowledge_content');
      // Shared with resolveCorpusInlinePlan's lookup (same turn, same memo) - one DB read, not two.
      expect(getAccessibleFiles).toHaveBeenCalledTimes(1);
      // The invisible-failure warning must stay silent: withholding here is deliberate, not a bug.
      expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/search_knowledge_base is not offered/));
    });

    it('still offers both knowledge tools for a fully-indexed attachment (regression)', async () => {
      const { enabledToolsArg, getAccessibleFiles } = await runKnowledgeGatingCase({
        knowledgeIds: ['f1'],
        files: [{ id: 'f1', fileName: 'f1.pdf', vectorized: true, chunkCount: 2 }],
      });
      expect(enabledToolsArg).toContain('search_knowledge_base');
      expect(enabledToolsArg).toContain('retrieve_knowledge_content');
      expect(getAccessibleFiles).toHaveBeenCalledTimes(1);
    });

    it('offers both knowledge tools from an accessible lake with no attachment, and never reads files', async () => {
      const { enabledToolsArg, getAccessibleFiles } = await runKnowledgeGatingCase({
        knowledgeIds: [],
        dataLakeTags: ['datalake:corpus'],
      });
      expect(enabledToolsArg).toContain('search_knowledge_base');
      expect(enabledToolsArg).toContain('retrieve_knowledge_content');
      expect(getAccessibleFiles).not.toHaveBeenCalled();
    });

    it('withholds the offer under promptMode and never reads files, even with a pending attachment', async () => {
      const { enabledToolsArg, getAccessibleFiles } = await runKnowledgeGatingCase({
        knowledgeIds: ['f1'],
        promptMode: 'raw',
        files: [{ id: 'f1', fileName: 'f1.pdf', vectorized: false, chunkCount: 0 }],
      });
      expect(enabledToolsArg).not.toContain('search_knowledge_base');
      expect(enabledToolsArg).not.toContain('retrieve_knowledge_content');
      expect(getAccessibleFiles).not.toHaveBeenCalled();
    });

    it('fails OPEN (still offers the tools) and completes the turn when the file lookup throws', async () => {
      const { enabledToolsArg } = await runKnowledgeGatingCase({
        knowledgeIds: ['f1'],
        getAccessibleFilesImpl: () => Promise.reject(new Error('db down')),
      });
      expect(enabledToolsArg).toContain('search_knowledge_base');
      expect(enabledToolsArg).toContain('retrieve_knowledge_content');
    });

    it('offers neither knowledge tool with no attachment and no accessible lake (baseline)', async () => {
      const { enabledToolsArg, getAccessibleFiles } = await runKnowledgeGatingCase({ knowledgeIds: [] });
      expect(enabledToolsArg).not.toContain('search_knowledge_base');
      expect(enabledToolsArg).not.toContain('retrieve_knowledge_content');
      expect(getAccessibleFiles).not.toHaveBeenCalled();
    });

    // Withholding the TOOL must not also withhold the CONTENT: the file's raw text still reaches
    // the model via the ordinary attachedFiles inline path (processFabFilesServer), regardless of
    // whether the knowledge tool was offered for it.
    it('still inlines the pending attachment content even though the tool is withheld', async () => {
      const { enabledToolsArg, contextAndSystemMessages } = await runKnowledgeGatingCase({
        knowledgeIds: ['f1'],
        files: [{ id: 'f1', fileName: 'f1.pdf', vectorized: false, chunkCount: 0 }],
        fabPromptMessages: [
          { role: 'system', content: 'Here is the content from the attached file f1.pdf: PENDING_FILE_MARKER' },
        ],
      });
      expect(enabledToolsArg).not.toContain('search_knowledge_base');
      expect(
        contextAndSystemMessages.some(m => typeof m.content === 'string' && m.content.includes('PENDING_FILE_MARKER'))
      ).toBe(true);
    });
  });

  // A prompt block that describes a tool has to be gated on the BUILT tool list, not the requested
  // one: the two diverge for auto-added tools on local models, and for anything the session denylist
  // strips after the build. Asserted at this layer because neither the builder's own tests nor the
  // view-registry helper can see which list the caller consulted.
  describe('tool-conditional prompt gating', () => {
    const imageTool = { toolSchema: { name: 'image_generation', description: 'gen', parameters: {} } };
    const navigateTool = { toolSchema: { name: 'navigate_view', description: 'nav', parameters: {} } };

    const runWithTools = async (tools: any[], disabledTools?: string[]) => {
      mockSession.disabledTools = disabledTools;
      const buildToolsSpy = vi.spyOn(ToolBuilder.prototype, 'buildTools').mockReturnValue(tools as any);
      const buildToolPromptSpy = vi.spyOn(ToolBuilder.prototype, 'buildToolPrompt').mockResolvedValue(null);

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_m: any, _msgs: any, _opts: any, cb: any) => {
          await cb(['Hi!']);
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      } as any);
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
      ] as any);
      mockedBuildAndSortMessages.mockClear();
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }] as any);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}] as any);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' } as any);

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await service.process({ body, logger: mockLogger });

      buildToolsSpy.mockRestore();
      buildToolPromptSpy.mockRestore();
      return mockedBuildAndSortMessages.mock.calls.at(-1);
    };

    // Argument 9 is the builder options bag; argument 2 is the assembled system-message list.
    const optionsPassedWithTools = async (tools: any[], disabledTools?: string[]) =>
      (await runWithTools(tools, disabledTools))?.[8];
    const hasViewRegistry = async (tools: any[]) =>
      ((await runWithTools(tools))?.[1] ?? ([] as any[])).some(
        (m: any) => typeof m?.content === 'string' && m.content.includes('# navigate_view Tool Usage')
      );

    it('reports the tool available when it survives into the built tool list', async () => {
      expect(await optionsPassedWithTools([imageTool])).toMatchObject({ imageGenerationAvailable: true });
    });

    it('reports it unavailable when the built tool list does not carry it', async () => {
      expect(await optionsPassedWithTools([])).toMatchObject({ imageGenerationAvailable: false });
    });

    // Availability has to be read AFTER the post-build denylist pass, not from the requested tools:
    // a session that forbids the tool has it stripped from the built list, and reading any earlier
    // would report it available on a turn where the model never receives it.
    it('reports it unavailable when the session denylist strips it from the built list', async () => {
      expect(await optionsPassedWithTools([imageTool], ['image_generation'])).toMatchObject({
        imageGenerationAvailable: false,
      });
    });

    it('includes the view registry when navigate_view is in the built tool list', async () => {
      expect(await hasViewRegistry([navigateTool])).toBe(true);
    });

    // navigate_view is auto-added, so a local model has it trimmed from the built list while the
    // requested list still names it. Gating on the requested list described a tool the model lacked.
    it('omits the view registry when navigate_view never reached the built tool list', async () => {
      expect(await hasViewRegistry([])).toBe(false);
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

  // Unavailable tools must not reach the model as a real schema, even when the client's
  // persisted preference still requests them - see toolAvailability.ts and sharedToolBuilder.ts's
  // enabledTools filter. Asserted at this layer because toolAvailability.ts's own tests cover the
  // resolver's logic in isolation, not whether ChatCompletionProcess actually computes and threads
  // the result into ToolBuilder.buildTools.
  describe('tool-availability computed and threaded into buildTools', () => {
    it('passes a resolved toolAvailability into buildTools', async () => {
      const buildToolsSpy = vi.spyOn(ToolBuilder.prototype, 'buildTools').mockReturnValue([]);
      buildToolsSpy.mockClear();
      const buildToolPromptSpy = vi.spyOn(ToolBuilder.prototype, 'buildToolPrompt').mockResolvedValue(null);

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_m, _msgs, _opts, cb) => cb(['Hi!'])),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      } as any);
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
      ] as any);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }] as any);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}] as any);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' } as any);

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await service.process({ body, logger: mockLogger });

      const toolAvailability = buildToolsSpy.mock.calls[0]?.[0]?.toolAvailability;
      buildToolsSpy.mockRestore();
      buildToolPromptSpy.mockRestore();

      expect(toolAvailability).toBeTypeOf('object');
    });
  });

  // SkillsFeature computes a catalog + expanded `/skill-name` body, but the drop (#1344) was in the
  // ASSEMBLY: the `skills` key was never spread into contextAndSystemMessages, so the model never saw
  // it. A unit test on getContextMessages passes without the spread, so this asserts against the
  // array actually handed to buildAndSortMessages - mirroring the assert-present/assert-absent
  // approach requested for the artifact prompt in #1301.
  describe('SkillsFeature context reaches the assembled system prompt (#1344)', () => {
    const ownedSkill = (overrides: Partial<ISkill>): ISkill =>
      ({
        id: 's1',
        name: 'skill',
        description: 'A skill',
        body: 'Body',
        userId: 'user1', // matches mockUser.id, so it renders as trusted (no untrusted wrapping)
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      }) as ISkill;

    // Runs a full turn and returns the flattened text of the system/context messages that the
    // assembly actually hands to buildAndSortMessages (its 2nd argument).
    const runAndCaptureSystemText = async (params: {
      message: string;
      catalog?: ISkill[];
      resolved?: ISkill[];
    }): Promise<string> => {
      mockDb.skills = {
        listAccessibleInvocableForUser: vi.fn().mockResolvedValue(params.catalog ?? []),
        findAccessibleByNamesForUser: vi.fn().mockResolvedValue(params.resolved ?? []),
      };
      // buildOptimizedFeatures is stubbed in beforeEach, so register the real feature under the
      // same key the assembly reads. This exercises both phases against the live feature.
      service.features.set('skills', new SkillsFeature(service));

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
      };
      await service.process({ body, logger: mockLogger });

      const contextAndSystemMessages = (mockedBuildAndSortMessages.mock.calls[0]?.[1] ?? []) as IMessage[];
      return contextAndSystemMessages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n---\n');
    };

    it('spreads the catalog and the expanded /skill invocation into the system messages', async () => {
      const systemText = await runAndCaptureSystemText({
        message: '/greet Bob',
        catalog: [ownedSkill({ name: 'greet', description: 'Greet someone' })],
        resolved: [ownedSkill({ name: 'greet', body: 'Say hello to $ARGUMENTS' })],
      });

      // Model-invocable catalog (the `skill` tool's discovery surface) reaches the prompt.
      expect(systemText).toContain('Available Skills');
      expect(systemText).toContain('/greet');
      // Explicit `/skill-name` expansion reaches the prompt with arguments substituted.
      expect(systemText).toContain('Skill Invoked: /greet');
      expect(systemText).toContain('Say hello to Bob');
    });

    it('emits no skills block when nothing is cataloged or invoked (assert-absent counterpart)', async () => {
      const systemText = await runAndCaptureSystemText({ message: 'just chatting, no slash command' });

      expect(systemText).not.toContain('Available Skills');
      expect(systemText).not.toContain('Skill Invoked');
    });

    // The priority table decides nothing unless the builder is handed the resolver. Dropping
    // systemMessagePriority from buildOptions leaves every table-level unit test passing and quietly
    // restores retention-by-array-position, so the wiring is asserted here rather than assumed.
    describe('retention priority reaches the builder', () => {
      const captureBuildOptions = async () => {
        await runAndCaptureSystemText({ message: 'just chatting' });
        const calls = mockedBuildAndSortMessages.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        return {
          options: calls[0]?.[8] as { systemMessagePriority?: (m: IMessage) => number | undefined },
          contextMessages: (calls[0]?.[1] ?? []) as IMessage[],
        };
      };

      it('resolves the date-context block to its table priority', async () => {
        const { options, contextMessages } = await captureBuildOptions();

        const dateContext = contextMessages.find(
          m => typeof m.content === 'string' && m.content.includes('Current date')
        );
        // Guards against a vacuous pass: with no date-context message there is nothing to resolve.
        expect(dateContext).toBeDefined();
        expect(options.systemMessagePriority?.(dateContext!)).toBe(SYSTEM_PROMPT_PRIORITY.dateContext);
      });

      it('resolves a block the assembly never produced to undefined, so the builder defaults it last', async () => {
        const { options } = await captureBuildOptions();

        // Asserted before the call, since an absent resolver would also yield undefined and make the
        // expectation below pass on exactly the wiring regression this describe exists to catch.
        expect(typeof options.systemMessagePriority).toBe('function');
        expect(options.systemMessagePriority!({ role: 'system', content: 'not from this assembly' })).toBeUndefined();
      });
    });
  });

  // Tool schemas ship to the provider as a separate `tools` param, so the local input estimate
  // must count them (previously hardcoded to 0). These pin the branch added for #811, including the
  // throw-path fallback that must NOT zero the messages-total floor - a zeroed inputTokens would
  // silently disable the overflow guard, under-reserve credits, and under-bill the fallback total.
  describe('tool-schema token counting (local input estimate)', () => {
    const probeTool = {
      toolSchema: {
        name: 'estimate_probe_tool',
        description: 'probe',
        parameters: { type: 'object', properties: {} },
      },
    };

    const runWithTools = async (opts: {
      tools: any[];
      // Either one count applied to every message source, or an explicit per-source queue in
      // calculateTotalTokenLength's call order: [messages, mementos, fab, url, history, userPrompt].
      // The per-source form lets a test give systemPrompts a non-degenerate value so the
      // "tools are not folded into the system-prompt remainder" property is actually asserted.
      messagesTokenCount?: number;
      sourceTokenCounts?: [number, number, number, number, number, number];
      // Full control over calculateTotalTokenLength, for the cases that need to differentiate the
      // real count from the estimateOnly one (e.g. rejecting the former and resolving the latter).
      tokenLengthImpl?: (messages: any, options: any) => Promise<number>;
      // countTokens serves BOTH the tool-schema count (string arg) and the output count (array
      // arg); the impl differentiates so a test can target one without disturbing the other.
      toolCountImpl: (text: any) => number;
    }): Promise<any> => {
      const buildToolsSpy = vi.spyOn(ToolBuilder.prototype, 'buildTools').mockReturnValue(opts.tools as any);
      const buildToolPromptSpy = vi.spyOn(ToolBuilder.prototype, 'buildToolPrompt').mockResolvedValue(null);

      mockedCalculateTotalTokenLength.mockReset();
      if (opts.tokenLengthImpl) {
        mockedCalculateTotalTokenLength.mockImplementation(opts.tokenLengthImpl as any);
      } else if (opts.sourceTokenCounts) {
        for (const n of opts.sourceTokenCounts) mockedCalculateTotalTokenLength.mockResolvedValueOnce(n);
      } else {
        mockedCalculateTotalTokenLength.mockResolvedValue(opts.messagesTokenCount ?? 0);
      }
      mockTokenizer.countTokens.mockReset().mockImplementation(async (text: any) => opts.toolCountImpl(text));
      mockedUsdToCredits.mockImplementation(realUsdToCredits);
      mockedUsdToCreditsStochastic.mockImplementation(usd => realUsdToCreditsStochastic(usd, () => 0));

      mockedGetLlmByModel.mockReturnValue({
        complete: vi.fn().mockImplementation(async (_m: any, _msgs: any, _opts: any, cb: any) => {
          await cb(['Hi!'], { inputTokens: 100, outputTokens: 50 });
        }),
        getModelInfo: vi.fn().mockResolvedValue([]),
        currentModel: ChatModels.GPT4,
      } as any);
      mockedGetAvailableModels.mockResolvedValue([
        {
          id: ChatModels.GPT4,
          type: 'text',
          name: 'GPT-4',
          backend: ModelBackend.OpenAI,
          max_tokens: 100,
          contextWindow: 200_000,
          can_stream: false,
          pricing: { 200000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
          supportsImageVariation: false,
        },
      ] as any);
      mockedBuildAndSortMessages.mockResolvedValue([{ role: 'user', content: 'Hello' }] as any);
      mockedFetchAndProcessPreviousMessages.mockResolvedValue([[], 0, {}] as any);
      mockedProcessUrlsFromPrompt.mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' } as any);

      const body = { ...startQuestParams, tools: [], projectId: undefined, organizationId: undefined };
      await service.process({ body, logger: mockLogger });

      // Second lookup for the runs where the breakdown itself fails: there is no tokensBySource to
      // key on, but tokenUsage still carries the figure the turn was billed on.
      const call =
        mockDb.quests.update.mock.calls.find(
          ([arg]: [any]) => arg?.promptMeta?.context?.tokensBySource !== undefined
        ) ?? mockDb.quests.update.mock.calls.find(([arg]: [any]) => arg?.promptMeta?.tokenUsage !== undefined);
      buildToolsSpy.mockRestore();
      buildToolPromptSpy.mockRestore();
      return call?.[0]?.promptMeta;
    };

    it('folds tool-schema tokens into inputTokens without inflating the systemPrompts remainder', async () => {
      // Per-source counts: messages 100, memento/fab/url 0, history 10, userPrompt 5; tools -> 30.
      // systemPrompts = totalTokens(100) - knownSources(0+0+0+10+5) = 85, independent of tools.
      // inputTokens = totalTokens(100) + toolSchemas(30) = 130. A mutation that derived
      // systemPrompts from inputTokens (115) or subtracted tools (55) would fail this.
      const promptMeta = await runWithTools({
        tools: [probeTool, probeTool],
        sourceTokenCounts: [100, 0, 0, 0, 10, 5],
        toolCountImpl: (text: any) => (typeof text === 'string' ? 30 : 7),
      });
      expect(promptMeta.context.tokensBySource.toolSchemas).toBe(30);
      expect(promptMeta.context.tokensBySource.systemPrompts).toBe(85);
      expect(promptMeta.tokenUsage.inputTokens).toBe(130);
    });

    it('serializes every tool as {name, description, input_schema} and joins them', async () => {
      // Two DISTINCT tools so the assertion pins both the per-tool wire shape and the N-tool join
      // (one tool passed twice, or dropping input_schema, would not survive this).
      const toolA = {
        toolSchema: {
          name: 'tool_a',
          description: 'first',
          parameters: { type: 'object', properties: { a: { type: 'string' } } },
        },
      };
      const toolB = {
        toolSchema: {
          name: 'tool_b',
          description: 'second',
          parameters: { type: 'object', properties: { b: { type: 'number' } } },
        },
      };
      const promptMeta = await runWithTools({
        tools: [toolA, toolB],
        messagesTokenCount: 0,
        toolCountImpl: (t: any) => (typeof t === 'string' ? 30 : 7),
      });
      const serialized = mockTokenizer.countTokens.mock.calls
        .map(([a]: [any]) => a)
        .find((a: any) => typeof a === 'string');
      expect(serialized).toBe(
        JSON.stringify({ name: 'tool_a', description: 'first', input_schema: toolA.toolSchema.parameters }) +
          JSON.stringify({ name: 'tool_b', description: 'second', input_schema: toolB.toolSchema.parameters })
      );
      expect(promptMeta.tokenUsage.inputTokens).toBe(30);
    });

    it('records zero tool-schema tokens when no tools are attached', async () => {
      const promptMeta = await runWithTools({
        tools: [],
        messagesTokenCount: 0,
        toolCountImpl: () => 7,
      });
      expect(promptMeta.context.tokensBySource.toolSchemas).toBe(0);
      expect(promptMeta.tokenUsage.inputTokens).toBe(0);
    });

    it('falls back to zero tool tokens WITHOUT zeroing the messages-total floor when the tokenizer throws', async () => {
      // A tool description with special-token literals trips tiktoken's encode(). The count must
      // degrade to 0 (tools uncounted) while inputTokens keeps the known-good messages total (50) -
      // not collapse to 0 and silently disable the overflow guard / under-reserve / under-bill.
      const promptMeta = await runWithTools({
        tools: [probeTool],
        messagesTokenCount: 50,
        toolCountImpl: (text: any) => {
          if (typeof text === 'string' && text.includes('estimate_probe_tool')) {
            throw new Error('Encountered text corresponding to disallowed special token');
          }
          return 7;
        },
      });
      expect(promptMeta.context.tokensBySource.toolSchemas).toBe(0);
      expect(promptMeta.tokenUsage.inputTokens).toBe(50); // messages floor preserved, NOT 0
      // The catch actually ran (distinguishes this from a no-tools/no-throw run).
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to count tool-schema tokens'),
        expect.anything()
      );
    });

    it('falls back to the char-based estimate when the whole breakdown throws, never leaving 0', async () => {
      // The tool-schema floor above only holds once the message counts have resolved. When the real
      // count rejects outright - a special-token literal in a user message, a WASM failure - nothing
      // has been assigned yet, so inputTokens used to stay 0: overflow guard and pre-reservation
      // check disabled, and on backends reporting no usage that 0 is what settles the turn.
      const promptMeta = await runWithTools({
        tools: [],
        tokenLengthImpl: async (_messages: any, options: any) => {
          if (!options?.estimateOnly) throw new Error('The text contains a special token that is not allowed');
          return 4242; // the estimate is char math, so it survives what the encoder could not
        },
        toolCountImpl: () => 7,
      });
      expect(promptMeta.tokenUsage.inputTokens).toBe(4242);
      // The breakdown genuinely failed - this is the fallback path, not a healthy run.
      expect(promptMeta.context?.tokensBySource).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Input tokens fell back to the char-based estimate')
      );
    });

    it('does not reject a turn for overflow on an estimated input count', async () => {
      // The estimator assumes 3.5 chars/token against prose that really runs ~6, so it over-counts
      // prose by up to ~1.7x. Throwing the context-overflow error on that figure would fail valid
      // turns - and the overflow-recovery loop never ran on this path either, so there was no
      // attempt to shed history first. The provider is the judge when we only have an estimate.
      const promptMeta = await runWithTools({
        tools: [],
        tokenLengthImpl: async (_messages: any, options: any) => {
          if (!options?.estimateOnly) throw new Error('The text contains a special token that is not allowed');
          return 250_000; // over the 200k window this harness's model declares
        },
        toolCountImpl: () => 7,
      });
      // Completed rather than throwing: promptMeta exists and carries the estimate.
      expect(promptMeta.tokenUsage.inputTokens).toBe(250_000);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping the context-overflow guard: input tokens are an estimate')
      );
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

describe('resolveEnabledTools', () => {
  it('offers search_knowledge_base (and pairs retrieve) when knowledge is attached', () => {
    const result = resolveEnabledTools({ requestTools: [], hasAttachedKnowledge: true });
    expect(result).toContain('search_knowledge_base');
    expect(result).toContain('retrieve_knowledge_content');
  });

  it('does not duplicate search_knowledge_base when the request already has it', () => {
    const result = resolveEnabledTools({
      requestTools: ['search_knowledge_base'],
      hasAttachedKnowledge: true,
    });
    expect(result.filter(t => t === 'search_knowledge_base')).toHaveLength(1);
  });

  it('lets the session denylist win over the attached-knowledge offer', () => {
    const result = resolveEnabledTools({
      requestTools: [],
      hasAttachedKnowledge: true,
      sessionDisabledTools: ['search_knowledge_base'],
    });
    expect(result).not.toContain('search_knowledge_base');
    // retrieve rides on search's pairing, so it must not survive alone either.
    expect(result).not.toContain('retrieve_knowledge_content');
  });

  it('leaves the tool list untouched when no knowledge is attached', () => {
    const result = resolveEnabledTools({ requestTools: ['web_search'], hasAttachedKnowledge: false });
    expect(result).toEqual(['web_search']);
  });

  it('skips the attached-knowledge offer when skipAutoOffers is set (prompt-mode eval)', () => {
    const result = resolveEnabledTools({
      requestTools: [],
      hasAttachedKnowledge: true,
      skipAutoOffers: true,
    });
    expect(result).not.toContain('search_knowledge_base');
    expect(result).not.toContain('retrieve_knowledge_content');
  });

  it('still honors caller-selected knowledge tools under skipAutoOffers', () => {
    // skipAutoOffers gates only OUR offer; a tool the caller explicitly sent stays and still pairs.
    const result = resolveEnabledTools({
      requestTools: ['search_knowledge_base'],
      hasAttachedKnowledge: true,
      skipAutoOffers: true,
    });
    expect(result).toContain('search_knowledge_base');
    expect(result).toContain('retrieve_knowledge_content');
  });

  it('skips the accessible-lake offer too when skipAutoOffers is set', () => {
    // The prompt-mode gate must cover the lake signal, or raw-mode evals leak the tool via a lake.
    const result = resolveEnabledTools({
      requestTools: [],
      hasAttachedKnowledge: false,
      hasAccessibleDataLake: true,
      skipAutoOffers: true,
    });
    expect(result).not.toContain('search_knowledge_base');
  });

  it('offers search_knowledge_base when the caller has an accessible lake (no attachment)', () => {
    const result = resolveEnabledTools({
      requestTools: [],
      hasAttachedKnowledge: false,
      hasAccessibleDataLake: true,
    });
    expect(result).toContain('search_knowledge_base');
    expect(result).toContain('retrieve_knowledge_content');
  });

  it('does not offer the knowledge tool when neither attachment nor accessible lake is present', () => {
    const result = resolveEnabledTools({
      requestTools: ['web_search'],
      hasAttachedKnowledge: false,
      hasAccessibleDataLake: false,
    });
    expect(result).toEqual(['web_search']);
  });

  it('lets the session denylist win over the accessible-lake offer', () => {
    const result = resolveEnabledTools({
      requestTools: [],
      hasAttachedKnowledge: false,
      hasAccessibleDataLake: true,
      sessionDisabledTools: ['search_knowledge_base'],
    });
    expect(result).not.toContain('search_knowledge_base');
    expect(result).not.toContain('retrieve_knowledge_content');
  });

  it('pairs edit_image for a session-forced image_generation (latent-gap fix)', () => {
    const result = resolveEnabledTools({
      requestTools: [],
      sessionEnabledTools: ['image_generation'],
      hasAttachedKnowledge: false,
    });
    expect(result).toContain('image_generation');
    expect(result).toContain('edit_image');
  });

  it('strips a denied companion (edit_image) even when its trigger stays', () => {
    const result = resolveEnabledTools({
      requestTools: ['image_generation'],
      hasAttachedKnowledge: false,
      sessionDisabledTools: ['edit_image'],
    });
    expect(result).toContain('image_generation');
    expect(result).not.toContain('edit_image');
  });

  it('is idempotent on its own output', () => {
    const once = resolveEnabledTools({
      requestTools: ['web_search'],
      sessionEnabledTools: ['image_generation'],
      hasAttachedKnowledge: true,
    });
    const twice = resolveEnabledTools({ requestTools: once, hasAttachedKnowledge: true });
    expect(twice).toEqual(once);
  });
});

describe('shouldDeferCorpusToRetrieval (per-doc even-split depth floor)', () => {
  it('is OFF (never defers) when the threshold is 0, regardless of size', () => {
    expect(
      shouldDeferCorpusToRetrieval({ retrievableCount: 40, attachedFileTokenBudget: 4000, minInlineTokensPerDoc: 0 })
    ).toBe(false);
  });

  it('defers when the per-doc split falls below the floor (large corpus)', () => {
    // 4000 / 40 = 100 < 500
    expect(
      shouldDeferCorpusToRetrieval({ retrievableCount: 40, attachedFileTokenBudget: 4000, minInlineTokensPerDoc: 500 })
    ).toBe(true);
  });

  it('keeps a small corpus inlined (per-doc split stays above the floor)', () => {
    // 4000 / 3 = 1333 >= 500
    expect(
      shouldDeferCorpusToRetrieval({ retrievableCount: 3, attachedFileTokenBudget: 4000, minInlineTokensPerDoc: 500 })
    ).toBe(false);
  });

  it('treats the floor as strict (depth exactly equal to the floor stays inlined)', () => {
    // 1000 / 2 = 500, not < 500
    expect(
      shouldDeferCorpusToRetrieval({ retrievableCount: 2, attachedFileTokenBudget: 1000, minInlineTokensPerDoc: 500 })
    ).toBe(false);
  });

  it('never defers when nothing is retrievable', () => {
    expect(
      shouldDeferCorpusToRetrieval({ retrievableCount: 0, attachedFileTokenBudget: 4000, minInlineTokensPerDoc: 500 })
    ).toBe(false);
  });
});

describe('attachmentHasIndexedContent (readable-chunk-text predicate, #1163)', () => {
  it('is true once chunking completes, even before vectorizedChunkCount catches up', () => {
    expect(attachmentHasIndexedContent({ vectorized: true, chunkCount: 0 })).toBe(true);
  });

  it('is true from chunk count alone, without waiting on the vectorized flag', () => {
    expect(attachmentHasIndexedContent({ vectorized: false, chunkCount: 3 })).toBe(true);
  });

  it('is false for a freshly attached file with no chunks yet (the #1163 gap)', () => {
    expect(attachmentHasIndexedContent({ vectorized: false, chunkCount: 0 })).toBe(false);
  });

  // chunkCount is bumped to a nonzero value here (the ticket's literal 0 can't exercise this
  // guard - it would already read false without deletedAt) to prove deletedAt overrides an
  // otherwise-truthy chunk signal.
  it('is false for a soft-deleted file regardless of chunk count', () => {
    expect(attachmentHasIndexedContent({ vectorized: false, chunkCount: 3, deletedAt: new Date() })).toBe(false);
  });

  it('is false for an archived file even when fully vectorized', () => {
    expect(attachmentHasIndexedContent({ vectorized: true, chunkCount: 0, archivedAt: new Date() })).toBe(false);
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

  // #1238: the org-wide balance is a HARD STOP - the settlement true-up must never drive it
  // negative. Pin the invariant across a swept input range, not just the examples above, so a
  // future refactor of the clamp can't quietly reintroduce a negative-balance path.
  // The grid below is deliberately coarse non-negative INTEGERS so the conservation assertion can use
  // exact equality. Real credits are token-derived floats, where `collected + writtenOff === shortfall`
  // is not exact - hence the separate fractional case, which asserts the floor exactly (it is a
  // comparison, not a sum) and conservation approximately.
  it('never drives the settled balance below zero, and conserves the shortfall (hard-stop invariant)', () => {
    for (let reserved = 0; reserved <= 200; reserved += 25) {
      for (let used = 0; used <= 300; used += 25) {
        for (let available = 0; available <= 300; available += 25) {
          const { delta, writtenOffCredits } = computeSettlementDelta(reserved, used, available);
          // The balance already moved by `reserved` at reservation; settlement applies `delta`.
          // Post-settlement balance = available + delta and must never be negative.
          expect(available + delta).toBeGreaterThanOrEqual(0);
          expect(writtenOffCredits).toBeGreaterThanOrEqual(0);
          if (used <= reserved) {
            // Over- or exactly-reserved: pure refund/no-op, nothing written off.
            expect(writtenOffCredits).toBe(0);
            expect(delta).toBe(reserved - used);
          } else {
            // Under-reserved: the shortfall is either collected (via -delta) or written off,
            // and the collected part is clamped to what the balance can actually cover.
            const shortfall = used - reserved;
            // delta <= 0 here (a shortfall debit); Math.abs avoids a -0 vs +0 Object.is mismatch.
            const collected = Math.abs(delta);
            expect(collected + writtenOffCredits).toBe(shortfall);
            expect(collected).toBe(Math.min(shortfall, available));
          }
        }
      }
    }
  });

  it('holds the floor for fractional credits (token-derived costs are not integers)', () => {
    const fractional: Array<[number, number, number]> = [
      [0.1, 0.30000000000000004, 0.15], // shortfall the balance only partly covers
      [1.7, 2.9, 0.05],
      [0.25, 0.25, 0.1], // exact settlement on a fractional basis
      [0.2, 0.7, 0], // whole shortfall written off at zero balance
      [3.3, 1.1, 0.5], // over-reserved: fractional refund
    ];
    for (const [reserved, used, available] of fractional) {
      const { delta, writtenOffCredits } = computeSettlementDelta(reserved, used, available);
      expect(available + delta).toBeGreaterThanOrEqual(0);
      expect(writtenOffCredits).toBeGreaterThanOrEqual(0);
      if (used > reserved) {
        // Conservation only up to FP error here; its exact form is pinned by the integer sweep above.
        expect(Math.abs(delta) + writtenOffCredits).toBeCloseTo(used - reserved, 10);
      }
    }
  });
});

describe('clampFraction (verbatim window fraction admin setting)', () => {
  it('passes through a valid numeric fraction', () => {
    expect(clampFraction(0.3, 0.55)).toBe(0.3);
    expect(clampFraction(1, 0.55)).toBe(1);
  });

  it('parses a numeric string (admin settings persist as strings)', () => {
    expect(clampFraction('0.9', 0.55)).toBe(0.9);
  });

  it('falls back on out-of-range, zero, negative, or non-finite input', () => {
    expect(clampFraction(0, 0.55)).toBe(0.55);
    expect(clampFraction(-0.2, 0.55)).toBe(0.55);
    expect(clampFraction(1.5, 0.55)).toBe(0.55);
    expect(clampFraction('not-a-number', 0.55)).toBe(0.55);
    expect(clampFraction(undefined, 0.55)).toBe(0.55);
  });
});

describe('dropOldestHistoryTurn (overflow-recovery shed)', () => {
  // A human turn starts at a user message with STRING content; tool results are
  // user messages with ARRAY content and must never be treated as a boundary.
  const user = (text: string): IMessage => ({ role: 'user', content: text });
  const assistant = (text: string): IMessage => ({ role: 'assistant', content: text });
  const toolResult = (): IMessage => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
  });

  it('drops the oldest whole turn, leaving the remainder on a clean boundary', () => {
    const history = [user('q1'), assistant('a1'), user('q2'), assistant('a2')];
    expect(dropOldestHistoryTurn(history)).toEqual([user('q2'), assistant('a2')]);
  });

  it('never splits a tool_use/tool_result pair (array-content user msg is not a boundary)', () => {
    const history = [user('q1'), assistant('a1'), toolResult(), user('q2'), assistant('a2')];
    // The oldest turn is q1 + a1 + its tool_result; the next boundary is q2.
    expect(dropOldestHistoryTurn(history)).toEqual([user('q2'), assistant('a2')]);
  });

  it('returns null when only one turn remains (nothing safe to shed)', () => {
    expect(dropOldestHistoryTurn([user('q1'), assistant('a1'), toolResult()])).toBeNull();
  });

  it('returns null on empty history', () => {
    expect(dropOldestHistoryTurn([])).toBeNull();
  });

  it('sheds turn-by-turn down to the most recent when called repeatedly', () => {
    let history: IMessage[] | null = [
      user('q1'),
      assistant('a1'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
    ];
    history = dropOldestHistoryTurn(history);
    expect(history).toEqual([user('q2'), assistant('a2'), user('q3'), assistant('a3')]);
    history = dropOldestHistoryTurn(history!);
    expect(history).toEqual([user('q3'), assistant('a3')]);
    expect(dropOldestHistoryTurn(history!)).toBeNull();
  });
});
