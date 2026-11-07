import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAndSortMessages,
  fetchAndProcessPreviousMessages,
  processUrlsFromPrompt,
  processFabFilesServer,
  fetchAndConvertFabFiles,
} from '@bike4mind/utils';
import { getLlmByModel, getAvailableModels, LlmTimeoutError } from '@bike4mind/llm-adapters';
import { ChatModels, ModelBackend, type IMessage } from '@bike4mind/common';
import { ChatCompletionProcess } from './ChatCompletionProcess';

vi.mock('./llmUsageSettledLog', () => ({ logLlmUsageSettled: vi.fn() }));
vi.mock('../userService/moderationPolicy', () => ({
  applyModerationHit: vi.fn().mockResolvedValue({ hitsInWindow: 1, status: 'active' }),
  MODERATION_POLICY: {},
  moderationThrottleKey: vi.fn(),
}));
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
  processFabFilesServer: vi.fn(),
  fetchAndConvertFabFiles: vi.fn(),
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
  BedrockGuardrailsService: vi.fn().mockImplementation(function () {
    return { checkPrompt: vi.fn() };
  }),
  ClientMessageSender: vi.fn().mockImplementation(function () {
    return { send: vi.fn(), close: vi.fn() };
  }),
  EmbeddingFactory: vi.fn().mockImplementation(function () {
    return { embed: vi.fn() };
  }),
  getProviderFromModel: vi.fn().mockReturnValue('openai'),
  getSettingsByNames: vi.fn().mockResolvedValue({}),
}));
vi.mock('../apiKeyService', () => ({
  getEffectiveApiKey: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  sharedAdminKeyProviders: vi.fn(),
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

const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
  debug: vi.fn(),
};

const FAILED_SUMMARY = 'LLM completion failed with';

describe('ChatCompletionProcess failed attempt logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetAvailableModels.mockReset().mockResolvedValue([
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
    ] as never);
    mockedBuildAndSortMessages.mockReset().mockImplementation((async (
      previous: IMessage[],
      context: IMessage[],
      prompt: IMessage[]
    ) => ({
      messages: [...(context ?? []), ...(previous ?? []), ...(prompt ?? [])],
      currentTurnMessageCount: prompt?.length ?? 0,
      messageTruncation: null,
    })) as never);
    mockedFetchAndProcessPreviousMessages.mockReset().mockResolvedValue([[], 0, {}] as never);
    mockedProcessUrlsFromPrompt.mockReset().mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' } as never);
    vi.mocked(processFabFilesServer).mockResolvedValue({
      userMessages: [],
      fileNotices: [],
      deliveredFileIds: [],
      fullyDeliveredFileIds: [],
    } as never);
    vi.mocked(fetchAndConvertFabFiles).mockResolvedValue({ files: [], missingIds: [] } as never);
  });

  const runFailingTurn = async (error: Error) => {
    const session = { id: 'session1', agentIds: [], userId: 'user1' };
    const quest = {
      id: 'quest1',
      status: 'running',
      promptMeta: { context: {}, performance: {} },
      replies: [],
      type: 'message',
      timestamp: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      sessions: {
        findById: vi.fn().mockResolvedValue(session),
        update: vi.fn(),
        attachAgent: vi.fn().mockResolvedValue(session),
        addAutoAddedTools: vi.fn().mockResolvedValue(undefined),
      },
      organizations: {
        findById: vi.fn(),
        update: vi.fn(),
        findMembershipOrgIds: vi.fn().mockResolvedValue([]),
        findIdsWithAdminRights: vi.fn().mockResolvedValue([]),
      },
      quests: {
        findById: vi.fn().mockResolvedValue(quest),
        findByIdWithStatus: vi.fn().mockResolvedValue(quest),
        update: vi.fn().mockResolvedValue(undefined),
        updateIfUnfinished: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
      },
      mcpServers: { find: vi.fn().mockResolvedValue([]) },
      users: { update: vi.fn() },
      fabfiles: {},
      fabfilechunks: {},
      adminSettings: { findOne: vi.fn().mockResolvedValue(null) },
      questMasterPlans: {},
      connections: {},
      creditTransactions: {},
      agents: {},
      projects: { findById: vi.fn() },
    };
    const tokenizer = {
      countTokens: vi.fn().mockResolvedValue(100),
      encodeTokens: vi.fn().mockResolvedValue([1, 2, 3]),
      clearCache: vi.fn(),
      getCacheStats: vi.fn().mockReturnValue({ size: 0, keys: [] }),
      warmUpCache: vi.fn().mockResolvedValue(undefined),
    };
    // The options are a wide host-wiring bag; this supplies only what one chat turn reads.
    const service = new ChatCompletionProcess({
      db,
      storage: {},
      queue: {},
      questProcessUrl: '',
      wsHttpsUrl: '',
      slackWebhookUrl: '',
      abilityGetter: vi.fn(),
      autoNameSession: vi.fn(),
      summarizeSession: vi.fn(),
      getMcpClient: vi.fn(),
      logEvent: vi.fn(),
      logger,
      getScopeFilter: vi.fn(),
      user: { id: 'user1', currentCredits: 10000, isAdmin: false },
      sessionId: 'session1',
      tokenizer,
      workspaceDeniedTools: {},
      workspaceSessionSettings: {},
    } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);
    (service as unknown as { statusManager: unknown }).statusManager = { sendStatusUpdate: vi.fn() };
    vi.spyOn(service, 'sendStatusUpdate').mockResolvedValue(undefined);
    vi.spyOn(service as never, 'loadAdminSettingsAsync').mockResolvedValue({} as never);
    vi.spyOn(service as never, 'fabFilesToMessages').mockResolvedValue({
      promptMessages: [],
      convertedFabFiles: [],
    } as never);

    mockedGetLlmByModel.mockReset().mockReturnValue({
      complete: vi.fn().mockRejectedValue(error),
      getModelInfo: vi.fn().mockResolvedValue([]),
      currentModel: ChatModels.GPT4,
    } as never);

    const body = {
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
      tools: [],
      projectId: undefined,
      organizationId: undefined,
    };
    await service.process({ body, logger } as never).catch(() => undefined);
  };

  const summaryCalls = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.filter(([message]) => typeof message === 'string' && message.includes(FAILED_SUMMARY));

  it('a safety refusal is not logged as an error or raw warn, and its summary goes to debug', async () => {
    const refusal = new Error('Anthropic safety classifier refusal for model-x - falling back to an alternative model');
    await runFailingTurn(refusal);

    expect(logger.error).not.toHaveBeenCalledWith(refusal);
    expect(logger.warn).not.toHaveBeenCalledWith(refusal);
    expect(summaryCalls(logger.debug)).toHaveLength(1);
    expect(summaryCalls(logger.warn)).toHaveLength(0);
  });

  it('a typed timeout is not logged as an error, and its summary goes to debug', async () => {
    const timeout = new LlmTimeoutError('request', 60_000, 'request timeout - no response received after 60000ms');
    await runFailingTurn(timeout);

    expect(logger.error).not.toHaveBeenCalledWith(timeout);
    expect(summaryCalls(logger.debug)).toHaveLength(1);
    expect(summaryCalls(logger.warn)).toHaveLength(0);
  });

  it('an unexpected error is still logged as an error and its summary goes to warn', async () => {
    const unexpected = new Error('boom: something unexpected');
    await runFailingTurn(unexpected);

    expect(logger.error).toHaveBeenCalledWith(unexpected);
    expect(summaryCalls(logger.warn)).toHaveLength(1);
    expect(summaryCalls(logger.debug)).toHaveLength(0);
  });
});
