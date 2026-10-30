import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAndSortMessages,
  fetchAndProcessPreviousMessages,
  processUrlsFromPrompt,
  processFabFilesServer,
  fetchAndConvertFabFiles,
  getSettingsValue,
  shouldTriggerFallback,
  getLlmWithFallback,
  type HistoryToolTurn,
} from '@bike4mind/utils';
import { getLlmByModel, getAvailableModels, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import {
  ChatModels,
  DEFERRED_ANCHOR_TOOL_NAME,
  isToolChangeMessage,
  ModelBackend,
  type IMessage,
} from '@bike4mind/common';
import { ChatCompletionProcess } from './ChatCompletionProcess';

// Process-level coverage for the deferred tool loading wiring. The module mocks mirror
// ChatCompletionProcess.adminAssistant.test.ts; ToolBuilder runs for real.

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
  getProviderFromModel: vi.fn().mockReturnValue('anthropic'),
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

const PRIMARY = ChatModels.CLAUDE_4_8_OPUS;

const modelRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'text',
  name: id,
  backend: ModelBackend.Anthropic,
  max_tokens: 100,
  contextWindow: 200_000,
  can_stream: false,
  pricing: {},
  supportsImageVariation: false,
  supportsTools: true,
  ...overrides,
});

type PastTurn = { prompt: string; offered: string[]; called?: string[] };

type TurnInput = {
  model?: string;
  settings?: Record<string, unknown>;
  requestTools?: string[];
  deniedTools?: string[];
  history?: PastTurn[];
  /** Make the primary fail once and hop to this model. */
  fallbackTo?: ReturnType<typeof modelRow>;
};

type Call = { messages: IMessage[]; tools: ICompletionOptionTools[] };

const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
  debug: vi.fn(),
};

const names = (tools: ICompletionOptionTools[]) => tools.map(tool => tool.toolSchema.name);
const deferredNames = (tools: ICompletionOptionTools[]) =>
  tools.filter(tool => tool.toolSchema.defer_loading).map(tool => tool.toolSchema.name);
const changeMessages = (messages: IMessage[]) => messages.filter(isToolChangeMessage);
const changedToolNames = (messages: IMessage[]) =>
  changeMessages(messages).flatMap(message =>
    (message.content as unknown as Array<{ tool?: { name: string } }>).flatMap(block =>
      block.tool ? [block.tool.name] : []
    )
  );

const runTurn = async (input: TurnInput): Promise<{ primary?: Call; hop?: Call }> => {
  const settings = input.settings ?? {};
  vi.mocked(getSettingsValue).mockImplementation(((name: string) => settings[name]) as never);

  const historyMessages: IMessage[] = [];
  const toolTurns: HistoryToolTurn[] = [];
  for (const past of input.history ?? []) {
    const prompt: IMessage = { role: 'user', content: past.prompt };
    historyMessages.push(prompt, { role: 'assistant', content: `reply to ${past.prompt}` });
    toolTurns.push({ prompt, offeredTools: past.offered, calledTools: past.called ?? [] });
  }
  vi.mocked(fetchAndProcessPreviousMessages).mockResolvedValue([
    historyMessages,
    historyMessages.length,
    { toolTurns },
  ] as never);

  const session = { id: 'session1', agentIds: [], userId: 'user1' };
  const quest = {
    id: 'quest1',
    status: 'running',
    promptMeta: {
      context: {},
      performance: {},
      model: { name: input.model ?? PRIMARY, backend: ModelBackend.Anthropic },
    },
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
  const internals = service as unknown as {
    loadAdminSettingsAsync: () => Promise<unknown>;
    fabFilesToMessages: () => Promise<unknown>;
  };
  vi.spyOn(internals, 'loadAdminSettingsAsync').mockResolvedValue({});
  vi.spyOn(internals, 'fabFilesToMessages').mockResolvedValue({ promptMessages: [], convertedFabFiles: [] });

  const result: { primary?: Call; hop?: Call } = {};
  const capture =
    (slot: 'primary' | 'hop') =>
    async (_model: unknown, messages: IMessage[], options: { tools?: ICompletionOptionTools[] }) => {
      result[slot] = { messages: [...messages], tools: [...(options.tools ?? [])] };
    };
  const primaryComplete = vi.fn().mockImplementation(async (model, messages, options, callback) => {
    await capture('primary')(model, messages, options);
    if (input.fallbackTo) throw new Error('ServiceUnavailableException: primary outage');
    await callback(['Hi!'], { inputTokens: 100, outputTokens: 50 });
  });
  vi.mocked(getLlmByModel)
    .mockReset()
    .mockReturnValue({
      complete: primaryComplete,
      getModelInfo: vi.fn().mockResolvedValue([]),
      currentModel: PRIMARY,
    } as never);
  vi.mocked(shouldTriggerFallback).mockReturnValue(!!input.fallbackTo);
  vi.mocked(getLlmWithFallback).mockResolvedValue(
    input.fallbackTo
      ? ({
          model: input.fallbackTo,
          backend: {
            complete: vi.fn().mockImplementation(async (model, messages, options, callback) => {
              await capture('hop')(model, messages, options);
              await callback(['Hi!'], { inputTokens: 100, outputTokens: 50 });
            }),
            getModelInfo: vi.fn().mockResolvedValue([]),
            currentModel: input.fallbackTo.id,
          },
          attempt: 1,
        } as never)
      : null
  );

  const body = {
    userId: 'user1',
    sessionId: 'session1',
    questId: 'quest1',
    message: 'Hello',
    messageFileIds: [],
    historyCount: 10,
    fabFileIds: [],
    params: { model: input.model ?? PRIMARY, temperature: 0.5, top_p: 1, max_tokens: 10 },
    queryComplexity: 'simple',
    promptMeta: {},
    tools: input.requestTools ?? [],
    deniedTools: input.deniedTools,
    projectId: undefined,
    organizationId: undefined,
  };
  await service.process({ body, logger } as never);
  return result;
};

const ON = { EnableDeferredToolLoading: true };

describe('ChatCompletionProcess deferred tool loading', () => {
  beforeEach(() => {
    vi.mocked(getAvailableModels)
      .mockReset()
      .mockResolvedValue([modelRow(PRIMARY), modelRow(ChatModels.CLAUDE_4_5_SONNET)] as never);
    vi.mocked(buildAndSortMessages)
      .mockReset()
      .mockImplementation((async (previous: IMessage[], context: IMessage[], prompt: IMessage[]) => ({
        messages: [...(context ?? []), ...(previous ?? []), ...(prompt ?? [])],
        currentTurnMessageCount: prompt?.length ?? 0,
        messageTruncation: null,
      })) as never);
    vi.mocked(processUrlsFromPrompt)
      .mockReset()
      .mockResolvedValue({ userMessages: [], remainingPrompt: 'Hello' } as never);
    vi.mocked(processFabFilesServer).mockResolvedValue({
      userMessages: [],
      fileNotices: [],
      deliveredFileIds: [],
      fullyDeliveredFileIds: [],
    } as never);
    vi.mocked(fetchAndConvertFabFiles).mockResolvedValue({ files: [], missingIds: [] } as never);
  });

  describe('gating', () => {
    it('flag on, supporting Claude model: optional tools go out deferred with the anchor', async () => {
      const { primary } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history: [{ prompt: 'first', offered: ['current_model_details', 'dice_roll'] }],
      });

      expect(primary).toBeDefined();
      expect(names(primary!.tools)).toEqual(
        expect.arrayContaining(['current_model_details', 'math_evaluate', DEFERRED_ANCHOR_TOOL_NAME])
      );
      expect(deferredNames(primary!.tools)).toContain('math_evaluate');
      expect(deferredNames(primary!.tools)).toContain(DEFERRED_ANCHOR_TOOL_NAME);
      expect(deferredNames(primary!.tools)).not.toContain('current_model_details');
      expect(changedToolNames(primary!.messages)).toContain('math_evaluate');
    });

    it('flag on, new chat: the start set stays loaded', async () => {
      const { primary } = await runTurn({ settings: ON, requestTools: ['math_evaluate'] });

      expect(names(primary!.tools)).toContain(DEFERRED_ANCHOR_TOOL_NAME);
      expect(deferredNames(primary!.tools)).toEqual([DEFERRED_ANCHOR_TOOL_NAME]);
      expect(changeMessages(primary!.messages)).toEqual([]);
    });

    it('flag off: no defer_loading, no anchor, no tool change messages', async () => {
      const { primary } = await runTurn({
        settings: {},
        requestTools: ['math_evaluate'],
        history: [{ prompt: 'first', offered: ['current_model_details', 'dice_roll'] }],
      });

      expect(names(primary!.tools)).toContain('math_evaluate');
      expect(names(primary!.tools)).not.toContain(DEFERRED_ANCHOR_TOOL_NAME);
      expect(deferredNames(primary!.tools)).toEqual([]);
      expect(changeMessages(primary!.messages)).toEqual([]);
    });

    it("flag on, model without deferred tool addition: today's shape", async () => {
      const { primary } = await runTurn({
        model: ChatModels.CLAUDE_4_5_SONNET,
        settings: ON,
        requestTools: ['math_evaluate'],
        history: [{ prompt: 'first', offered: ['current_model_details', 'dice_roll'] }],
      });

      expect(primary).toBeDefined();
      expect(names(primary!.tools)).not.toContain(DEFERRED_ANCHOR_TOOL_NAME);
      expect(deferredNames(primary!.tools)).toEqual([]);
      expect(changeMessages(primary!.messages)).toEqual([]);
    });
  });

  describe('tools in history but no longer offered', () => {
    it('a denylisted tool is not declared', async () => {
      const { primary } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        deniedTools: ['dice_roll'],
        history: [
          { prompt: 'first', offered: ['current_model_details'] },
          { prompt: 'second', offered: ['current_model_details', 'dice_roll'], called: ['dice_roll'] },
        ],
      });

      expect(names(primary!.tools)).not.toContain('dice_roll');
      expect(changedToolNames(primary!.messages)).not.toContain('dice_roll');
      expect(names(primary!.tools)).toContain(DEFERRED_ANCHOR_TOOL_NAME);
    });

    it('a tool that no longer builds is undeclarable and written out of the plan', async () => {
      const { primary } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history: [
          { prompt: 'first', offered: ['current_model_details'] },
          { prompt: 'second', offered: ['current_model_details', 'no_such_tool'] },
        ],
      });

      expect(names(primary!.tools)).not.toContain('no_such_tool');
      expect(changedToolNames(primary!.messages)).not.toContain('no_such_tool');
      expect(changedToolNames(primary!.messages)).toContain('math_evaluate');
    });

    it('a declared-only tool is deferred and refuses the call', async () => {
      const { primary } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history: [
          { prompt: 'first', offered: ['current_model_details'] },
          { prompt: 'second', offered: ['current_model_details', 'dice_roll'] },
        ],
      });

      const declared = primary!.tools.find(tool => tool.toolSchema.name === 'dice_roll');
      expect(declared).toBeDefined();
      expect(declared!.toolSchema.defer_loading).toBe(true);
      expect(await declared!.toolFn({})).toBe('The dice_roll tool is not available in this conversation.');
      expect(changedToolNames(primary!.messages)).toEqual(expect.arrayContaining(['dice_roll']));
    });
  });

  describe('DeferredToolStartSetMaxTokens', () => {
    const history = [{ prompt: 'first', offered: ['current_model_details', 'math_evaluate'] }];

    it('without a limit, the start set is loaded', async () => {
      const { primary } = await runTurn({ settings: ON, requestTools: ['math_evaluate'], history });

      expect(names(primary!.tools)).toContain('math_evaluate');
      expect(deferredNames(primary!.tools)).not.toContain('math_evaluate');
    });

    it('a start set over the limit is deferred instead', async () => {
      const { primary } = await runTurn({
        settings: { ...ON, DeferredToolStartSetMaxTokens: 1 },
        requestTools: ['math_evaluate'],
        history,
      });

      expect(deferredNames(primary!.tools)).toContain('math_evaluate');
      expect(deferredNames(primary!.tools)).not.toContain('current_model_details');
      expect(changedToolNames(primary!.messages)).toContain('math_evaluate');
    });
  });

  describe('fallback hop', () => {
    const history = [
      { prompt: 'first', offered: ['current_model_details'] },
      { prompt: 'second', offered: ['current_model_details', 'dice_roll'] },
    ];

    const expectUndone = (hop: Call | undefined) => {
      expect(hop).toBeDefined();
      expect(deferredNames(hop!.tools)).toEqual([]);
      expect(names(hop!.tools)).not.toContain(DEFERRED_ANCHOR_TOOL_NAME);
      expect(names(hop!.tools)).not.toContain('dice_roll');
      expect(changeMessages(hop!.messages)).toEqual([]);
    };

    it('the primary request is deferred (precondition)', async () => {
      const { primary } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history,
        fallbackTo: modelRow(ChatModels.CLAUDE_4_5_SONNET),
      });

      expect(names(primary!.tools)).toEqual(expect.arrayContaining(['dice_roll', DEFERRED_ANCHOR_TOOL_NAME]));
      expect(changeMessages(primary!.messages).length).toBeGreaterThan(0);
    });

    it('a hop to a model without deferred tool addition gets the undeferred request', async () => {
      const { hop } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history,
        fallbackTo: modelRow(ChatModels.CLAUDE_4_5_SONNET),
      });

      expectUndone(hop);
      expect(names(hop!.tools)).toEqual(expect.arrayContaining(['current_model_details', 'math_evaluate']));
    });

    it('a hop to a model without deferred tool addition keeps a removed start-set tool declared', async () => {
      const { hop } = await runTurn({
        settings: ON,
        requestTools: ['dice_roll'],
        history: [{ prompt: 'first', offered: ['current_model_details', 'math_evaluate'] }],
        fallbackTo: modelRow(ChatModels.CLAUDE_4_5_SONNET),
      });

      expect(hop).toBeDefined();
      expect(changeMessages(hop!.messages)).toEqual([]);
      const declared = hop!.tools.find(tool => tool.toolSchema.name === 'math_evaluate');
      expect(declared).toBeDefined();
      expect(declared!.toolSchema.defer_loading).toBeUndefined();
      expect(await declared!.toolFn({})).toBe('The math_evaluate tool is not available in this conversation.');
    });

    it('a hop to a supporting model keeps the deferred request', async () => {
      const { hop } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history,
        fallbackTo: modelRow(ChatModels.CLAUDE_5_OPUS),
      });

      expect(deferredNames(hop!.tools)).toContain('math_evaluate');
      expect(changeMessages(hop!.messages).length).toBeGreaterThan(0);
    });

    it('a hop that withholds current_model_details, leaving nothing loaded, gets the undeferred request', async () => {
      const { hop } = await runTurn({
        settings: ON,
        requestTools: ['math_evaluate'],
        history,
        fallbackTo: modelRow(ChatModels.CLAUDE_5_OPUS, { supportsTools: false }),
      });

      expectUndone(hop);
      expect(names(hop!.tools)).not.toContain('current_model_details');
      expect(names(hop!.tools)).toContain('math_evaluate');
    });
  });
});
