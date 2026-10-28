import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAndSortMessages,
  fetchAndProcessPreviousMessages,
  processUrlsFromPrompt,
  processFabFilesServer,
  fetchAndConvertFabFiles,
} from '@bike4mind/utils';
import { getLlmByModel, getAvailableModels } from '@bike4mind/llm-adapters';
import { ADMIN_ASSISTANT_TOOL_NAMES, ChatModels, ModelBackend, type IMessage } from '@bike4mind/common';
import { ChatCompletionProcess } from './ChatCompletionProcess';
import type { ToolDefinition } from './tools/base/types';
import { ADMIN_ASSISTANT_SYSTEM_PROMPT } from './adminAssistantPrompt';

// Process-level coverage for the admin assistant gate. The module mocks mirror the harness in
// ChatCompletion.test.ts (kept to what a single chat turn needs); ToolBuilder.buildTools runs for
// real so the offered list is the one after the post-buildTools denylist pass.

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

const ADMIN_NAMES: readonly string[] = ADMIN_ASSISTANT_TOOL_NAMES;

const adminToolDefinition = (name: string): ToolDefinition => ({
  name,
  implementation: () => ({
    toolFn: async () => 'ok',
    toolSchema: { name, description: `${name} probe`, parameters: { type: 'object', properties: {} } },
  }),
});

const allAdminExternalTools = (): Record<string, ToolDefinition> =>
  Object.fromEntries(ADMIN_NAMES.map(name => [name, adminToolDefinition(name)]));

type TurnInput = {
  isAdmin: boolean;
  surface?: string | null;
  session?: Record<string, unknown>;
  requestTools?: string[];
  externalTools?: Record<string, ToolDefinition>;
};

type TurnResult = {
  modelCalled: boolean;
  offeredToolNames: string[];
  systemMessages: string[];
  addAutoAddedTools: ReturnType<typeof vi.fn>;
};

const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
  debug: vi.fn(),
};

describe('ChatCompletionProcess admin assistant gate', () => {
  beforeEach(() => {
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
    // Echo the admitted system/context stack so the stubbed LLM receives it, as the real builder does.
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

  const runTurn = async (input: TurnInput): Promise<TurnResult> => {
    const session = {
      id: 'session1',
      agentIds: [],
      userId: 'user1',
      surface: input.surface ?? undefined,
      ...input.session,
    };
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
    const addAutoAddedTools = vi.fn().mockResolvedValue(undefined);
    const db = {
      sessions: {
        findById: vi.fn().mockResolvedValue(session),
        update: vi.fn(),
        attachAgent: vi.fn().mockResolvedValue(session),
        addAutoAddedTools,
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
      user: { id: 'user1', currentCredits: 10000, isAdmin: input.isAdmin },
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

    const complete = vi.fn().mockImplementation(async (_model, _messages, _options, callback) => {
      await callback(['Hi!'], { inputTokens: 100, outputTokens: 50 });
    });
    mockedGetLlmByModel.mockReset().mockReturnValue({
      complete,
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
      tools: input.requestTools ?? [],
      projectId: undefined,
      organizationId: undefined,
    };
    await service.process({ body, logger, externalTools: input.externalTools } as never);

    const [, messages, options] = complete.mock.calls.at(-1) ?? [];
    const offeredToolNames = ((options?.tools ?? []) as Array<{ toolSchema: { name: string } }>).map(
      tool => tool.toolSchema.name
    );
    const systemMessages = ((messages ?? []) as IMessage[])
      .filter(message => message.role === 'system')
      .map(message =>
        typeof message.content === 'string' ? message.content : (JSON.stringify(message.content) ?? '')
      );
    return { modelCalled: complete.mock.calls.length > 0, offeredToolNames, systemMessages, addAutoAddedTools };
  };

  const offersNoAdminTool = (turn: TurnResult) => {
    // Guards against a vacuous pass: an empty list from a turn that never reached the model.
    expect(turn.modelCalled).toBe(true);
    expect(turn.offeredToolNames.filter(name => ADMIN_NAMES.includes(name))).toEqual([]);
  };
  const carriesNoAdminPrompt = (turn: TurnResult) =>
    expect(turn.systemMessages.some(content => content.includes(ADMIN_ASSISTANT_SYSTEM_PROMPT))).toBe(false);

  it('normal session, non-admin: no admin tool offered and no admin prompt', async () => {
    const turn = await runTurn({ isAdmin: false, surface: null, externalTools: allAdminExternalTools() });

    offersNoAdminTool(turn);
    carriesNoAdminPrompt(turn);
  });

  it('normal session, admin: no admin tools, no admin prompt', async () => {
    const turn = await runTurn({ isAdmin: true, surface: null, externalTools: allAdminExternalTools() });

    offersNoAdminTool(turn);
    carriesNoAdminPrompt(turn);
  });

  it('admin-assistant session, admin, admin definitions in externalTools: offers the admin tools and navigate_view, and the session prompt message starts with ADMIN_ASSISTANT_SYSTEM_PROMPT', async () => {
    const turn = await runTurn({
      isAdmin: true,
      surface: 'admin-assistant',
      session: { systemPromptText: 'SESSION PROMPT' },
      externalTools: allAdminExternalTools(),
    });

    expect(turn.offeredToolNames).toEqual(expect.arrayContaining([...ADMIN_NAMES, 'navigate_view']));
    const adminPromptMessages = turn.systemMessages.filter(content => content.includes(ADMIN_ASSISTANT_SYSTEM_PROMPT));
    expect(adminPromptMessages).toHaveLength(1);
    expect(adminPromptMessages[0].startsWith(ADMIN_ASSISTANT_SYSTEM_PROMPT)).toBe(true);
    expect(adminPromptMessages[0].endsWith('SESSION PROMPT')).toBe(true);
  });

  it('admin-assistant session, non-admin, admin names forced into session.enabledTools and the request tools: no admin tool offered, no admin prompt', async () => {
    const turn = await runTurn({
      isAdmin: false,
      surface: 'admin-assistant',
      session: { enabledTools: [...ADMIN_NAMES] },
      requestTools: [...ADMIN_NAMES],
      externalTools: allAdminExternalTools(),
    });

    offersNoAdminTool(turn);
    carriesNoAdminPrompt(turn);
  });

  it('admin-assistant session, user demoted (isAdmin false on this turn) with admin names in session.autoAddedTools: none offered', async () => {
    const turn = await runTurn({
      isAdmin: false,
      surface: 'admin-assistant',
      session: { autoAddedTools: [...ADMIN_NAMES] },
      externalTools: allAdminExternalTools(),
    });

    offersNoAdminTool(turn);
    carriesNoAdminPrompt(turn);
  });

  it('admin-assistant session, turn run by a non-admin collaborator on an admin-owned session: none offered', async () => {
    const turn = await runTurn({
      isAdmin: false,
      surface: 'admin-assistant',
      session: { userId: 'admin-owner', enabledTools: [...ADMIN_NAMES] },
      externalTools: allAdminExternalTools(),
    });

    offersNoAdminTool(turn);
    carriesNoAdminPrompt(turn);
  });

  it('admin-assistant session, admin, no externalTools: offers navigate_view only, does not throw', async () => {
    const turn = await runTurn({ isAdmin: true, surface: 'admin-assistant' });

    expect(turn.offeredToolNames).toContain('navigate_view');
    offersNoAdminTool(turn);
  });

  it('admin-assistant session, admin, one admin tool in session.disabledTools: that tool is withheld, the others offered', async () => {
    const turn = await runTurn({
      isAdmin: true,
      surface: 'admin-assistant',
      session: { disabledTools: ['admin_get_usage_signals'] },
      externalTools: allAdminExternalTools(),
    });

    const offeredAdminTools = turn.offeredToolNames.filter(name => ADMIN_NAMES.includes(name));
    expect(offeredAdminTools).not.toContain('admin_get_usage_signals');
    expect(offeredAdminTools).toEqual(expect.arrayContaining(ADMIN_NAMES.filter(n => n !== 'admin_get_usage_signals')));
  });

  it('gate never persists admin names', async () => {
    const turns = [
      await runTurn({ isAdmin: true, surface: 'admin-assistant', externalTools: allAdminExternalTools() }),
      await runTurn({
        isAdmin: false,
        surface: 'admin-assistant',
        session: { autoAddedTools: [...ADMIN_NAMES] },
        externalTools: allAdminExternalTools(),
      }),
    ];

    for (const turn of turns) {
      const persisted = turn.addAutoAddedTools.mock.calls.flatMap(call => (call[1] ?? []) as string[]);
      expect(persisted.filter(name => ADMIN_NAMES.includes(name))).toEqual([]);
    }
  });
});
