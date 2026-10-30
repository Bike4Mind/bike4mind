import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import type { ServerSubagentTracker } from '@bike4mind/services/llm';
import { OPTI_SURFACE, isShadowTier } from '@bike4mind/common';

// Model admission reads admin settings from the real repository; these tests exercise other gates.
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({ admits: async () => true, assert: async () => {} }),
}));

// Drives the real `handler` through a continuation message so the top-level `processExecution`
// builds its toolDeps, and asserts what it hands `buildSharedTools`. Module mocks mirror
// agentExecutor.subagentToolDeps.test.ts; buildSharedTools throws once captured to end the run.

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get() {
      return new Proxy({}, benignStub);
    },
  }),
}));

// Records every frame the real `createWsSender` posts, in the order the sends complete. While
// `holdTextDelta` is set, `subagent_text_delta` posts stay in flight until it resolves.
const ws = vi.hoisted(() => ({
  frames: [] as Array<{ action: string } & Record<string, unknown>>,
  holdTextDelta: null as Promise<void> | null,
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send(command: { input: { Data: Buffer } }) {
      const frame = JSON.parse(command.input.Data.toString()) as { action: string } & Record<string, unknown>;
      if (frame.action === 'subagent_text_delta' && ws.holdTextDelta) {
        return ws.holdTextDelta.then(() => {
          ws.frames.push(frame);
          return {};
        });
      }
      ws.frames.push(frame);
      return Promise.resolve({});
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('./agentExecutorDag', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutorDag')>('./agentExecutorDag');
  return { ...actual, onDagNodeTerminal: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('./agentExecutor.latticeTools', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutor.latticeTools')>('./agentExecutor.latticeTools');
  return { ...actual, buildSubagentLatticeToolPool: vi.fn().mockReturnValue([]) };
});
vi.mock('./agentExecutor.subagentToolConfig', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutor.subagentToolConfig')>(
    './agentExecutor.subagentToolConfig'
  );
  return { ...actual, buildSubagentToolConfig: vi.fn().mockReturnValue({}) };
});

vi.mock('./agentExecutor.videoToolConfig', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutor.videoToolConfig')>(
    './agentExecutor.videoToolConfig'
  );
  return {
    ...actual,
    getAgentVideoToolConfigDeps: vi.fn().mockReturnValue({
      resolveClipLimit: vi.fn().mockResolvedValue(2),
      buildBaseConfig: vi.fn().mockResolvedValue({ createJob: vi.fn() }),
      slots: { claim: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  };
});

vi.mock('./agentExecutor.musicToolConfig', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutor.musicToolConfig')>(
    './agentExecutor.musicToolConfig'
  );
  return {
    ...actual,
    getAgentMusicToolConfigDeps: vi.fn().mockReturnValue({
      resolveTrackLimit: vi.fn().mockResolvedValue(2),
      buildBaseConfig: vi.fn().mockResolvedValue({
        usableModels: ['test-music'],
        createJob: vi.fn().mockResolvedValue({ ok: true, created: true }),
      }),
      slots: { claim: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  };
});

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn().mockReturnValue({}),
  getGeneratedImageStorage: vi.fn().mockReturnValue({}),
}));

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([]),
    getLlmByModel: vi.fn().mockReturnValue({ currentModel: undefined }),
  };
});

const deductCreditsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
    creditService: { ...actual.creditService, deductCreditsWithOrgSupport: deductCreditsMock },
  };
});

const buildSharedToolsMock = vi.fn().mockReturnValue([]);

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    buildSharedTools: (...args: unknown[]) => buildSharedToolsMock(...args),
    ServerAgentStore: class {
      getAllAgents() {
        return [];
      }
      getExclusiveMcpServers() {
        return [];
      }
      getAgent() {
        return { name: 'researcher', allowedTools: [], deniedTools: [] };
      }
    },
    ServerSubagentOrchestrator: class {
      delegateToAgent() {
        return Promise.resolve({
          steps: [{ content: 'work' }],
          finalAnswer: 'done',
          completionInfo: { totalCredits: 0, totalTokens: 0, iterations: 1, reachedMaxIterations: false },
        });
      }
    },
  };
});

vi.mock('@bike4mind/services/llm/shadowTier', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm/shadowTier')>(
    '@bike4mind/services/llm/shadowTier'
  );
  const settings = { allowlist: ['cheap-model'], dailyTokenCap: 20000, requestsPerMin: 3 };
  return {
    ...actual,
    resolveShadowRouting: vi.fn(async ({ user, requested, models, logger }) =>
      isShadowTier(user)
        ? {
            settings,
            modelInfo: requested
              ? actual.resolveShadowModelInfo(user, requested, models, settings.allowlist, logger)
              : undefined,
          }
        : { settings: null, modelInfo: undefined }
    ),
  };
});

vi.mock('@server/utils/persistRunAsQuest', () => ({ persistRunAsQuest: vi.fn().mockResolvedValue(undefined) }));

const resolveWorkspaceSettings = vi.hoisted(() => vi.fn());
vi.mock('@server/premium-generated/premiumWorkspaceSessionSettings.generated', () => ({
  premiumWorkspaceSessionSettings: {
    'settings-workspace': { ownedFields: ['disableUserIntegrations'], resolve: resolveWorkspaceSettings },
    'responding-workspace': { ownedFields: [], resolve: async () => ({}), respond: async () => null },
  },
}));

vi.mock('@server/premium-generated/premiumLlmTools.generated', () => ({
  premiumLlmTools: { fixture_tool: { name: 'fixture_tool' } },
}));

vi.mock('@server/premium-generated/premiumAgentExtensions.generated', () => ({
  premiumAgentExtensions: [
    {
      surfaceProfiles: [
        {
          id: 'fixture-profile',
          surface: 'fixture-surface',
          build: () => ({
            id: 'fixture-profile',
            name: 'Fixture profile',
            allowedTools: ['fixture_tool'],
            deniedTools: [],
            maxIterations: { quick: 5, medium: 15, very_thorough: 30 },
            defaultThoroughness: 'medium',
            isSynthetic: true,
          }),
        },
      ],
    },
  ],
}));

// Pass-through spies, so the real registry still resolves and guards while the calls are observable.
vi.mock('./agentExecutor.agentExtensions', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutor.agentExtensions')>(
    './agentExecutor.agentExtensions'
  );
  const real = actual.executorAgentExtensions;
  return {
    ...actual,
    executorAgentExtensions: {
      ...real,
      resolveSurfaceProfile: vi.fn(real.resolveSurfaceProfile),
      applyToolMapGuards: vi.fn(real.applyToolMapGuards),
    },
  };
});

const execDoc = {
  id: 'exec-1',
  status: 'running',
  abortedAt: null,
  userId: 'user-1',
  sessionId: 'session-1',
  questId: 'quest-1',
  organizationId: null,
  model: 'claude-sonnet-5',
  query: 'summarize the attached files',
  messageFileIds: ['file-m'],
  sessionFabFileIds: ['file-f'],
};

const baseSession = { id: 'session-1', userId: 'user-1', disableUserIntegrations: true };

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  const repo = actual.agentExecutionRepository;
  vi.spyOn(repo, 'findById').mockResolvedValue(execDoc as never);
  vi.spyOn(repo, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(repo, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'incrementLambdaInvocationCount').mockResolvedValue(1 as never);
  vi.spyOn(repo, 'persistProfileDeniedTools').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'persistResolvedEnabledTools').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'markFailed').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'markAborted').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'checkAbortFlag').mockResolvedValue(false as never);
  vi.spyOn(actual.questRepository, 'addGenerationJobs').mockResolvedValue(undefined as never);
  vi.spyOn(actual.usageEventRepository, 'record').mockResolvedValue(undefined as never);
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue(baseSession as never);
  vi.spyOn(actual.organizationRepository, 'findById').mockResolvedValue(null as never);
  vi.spyOn(actual.agentRepository, 'listForUser').mockResolvedValue([] as never);
  vi.spyOn(actual.agentRepository, 'listForOrganization').mockResolvedValue([] as never);
  vi.spyOn(actual.adminSettingsRepository, 'getSettingsValue').mockResolvedValue(false as never);
  vi.spyOn(actual.adminSettingsRepository, 'findOne').mockResolvedValue(null as never);
  vi.spyOn(repo, 'markComplete').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'incrementCreditsUsed').mockResolvedValue(undefined as never);
  vi.spyOn(actual.cacheRepository, 'tryAddWithinLimitFixedWindow').mockResolvedValue({
    success: true,
    count: 1,
    expiresAt: new Date(),
  } as never);
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

const toolsBuilt = new Error('tools built');

function continuationEvent() {
  return {
    Records: [{ messageId: 'msg-1', body: JSON.stringify({ executionId: 'exec-1', connectionId: 'conn-1' }) }],
  } as never;
}

const lambdaContext = { getRemainingTimeInMillis: () => 600_000 } as never;

async function runWithSession(session: Record<string, unknown>) {
  const { sessionRepository } = await import('@bike4mind/database');
  vi.mocked(sessionRepository.findById).mockResolvedValue(session as never);
  const { handler } = await import('./agentExecutor');
  await handler(continuationEvent(), lambdaContext).catch(() => undefined);
  expect(buildSharedToolsMock).toHaveBeenCalledTimes(1);
  return buildSharedToolsMock.mock.calls[0][0] as Record<string, unknown>;
}

describe('processExecution tool deps', () => {
  beforeAll(async () => {
    await import('./agentExecutor');
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    ws.frames.length = 0;
    ws.holdTextDelta = null;
    buildSharedToolsMock.mockImplementation(() => {
      throw toolsBuilt;
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes every attached file and the resolved library opt-out to the tools', async () => {
    const deps = await runWithSession({ ...baseSession, knowledgeIds: ['file-k'], includeLibraryFiles: false });

    expect((deps.attachedFileIds as string[]).slice().sort()).toEqual(['file-f', 'file-k', 'file-m']);
    expect(deps.sessionIncludeLibraryFiles).toBe(false);
  });

  describe('admin role behind a key without the admin scope', () => {
    async function depsUserFor(doc: Record<string, unknown>) {
      const { agentExecutionRepository, User } = await import('@bike4mind/database');
      vi.mocked(User.findById).mockResolvedValueOnce({ id: 'user-1', currentCredits: 100, isAdmin: true } as never);
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce(doc as never);
      const deps = await runWithSession(baseSession);
      return deps.user as { isAdmin?: boolean };
    }

    async function depsUsersReadFor(doc: Record<string, unknown>) {
      const { agentExecutionRepository, userRepository } = await import('@bike4mind/database');
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce(doc as never);
      const deps = await runWithSession(baseSession);
      const users = (deps.db as { users: typeof userRepository }).users;
      const findUser = vi.spyOn(userRepository, 'findById').mockResolvedValueOnce({ isAdmin: true } as never);
      try {
        return { users, owner: (await users.findById('user-1')) as { isAdmin?: boolean } };
      } finally {
        findUser.mockRestore();
      }
    }

    it('withholds the owner admin role when the run was started that way', async () => {
      expect((await depsUserFor({ ...execDoc, apiKeyId: 'key-1', adminRoleWithheld: true })).isAdmin).toBe(false);
    });

    it('keeps the owner admin role for a run that does not withhold it', async () => {
      expect((await depsUserFor({ ...execDoc, apiKeyId: 'key-1' })).isAdmin).toBe(true);
    });

    it('withholds it from a tool that re-reads the owner by id', async () => {
      const { owner } = await depsUsersReadFor({ ...execDoc, apiKeyId: 'key-1', adminRoleWithheld: true });
      expect(owner.isAdmin).toBe(false);
    });

    it('hands tools the plain user repository for a run that does not withhold it', async () => {
      const { userRepository } = await import('@bike4mind/database');
      const { users, owner } = await depsUsersReadFor({ ...execDoc, apiKeyId: 'key-1' });
      expect(users).toBe(userRepository);
      expect(owner.isAdmin).toBe(true);
    });
  });

  describe('video_generation wiring', () => {
    const videoExecDoc = {
      ...execDoc,
      linkedQuestId: 'q-run',
      resolvedEnabledTools: ['video_generation'],
    };

    async function runWithExecDoc(doc: Record<string, unknown>) {
      const { agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce(doc as never);
      await runWithSession(baseSession);
    }

    it('offers the video tool to a run without an API key', async () => {
      const { buildSubagentToolConfig } = await import('./agentExecutor.subagentToolConfig');
      await runWithExecDoc(videoExecDoc);

      expect(vi.mocked(buildSubagentToolConfig).mock.calls[0][0].videoConfig).not.toBeNull();
    });

    it('withholds the video tool from a run started with an API key', async () => {
      const { buildSubagentToolConfig } = await import('./agentExecutor.subagentToolConfig');
      await runWithExecDoc({ ...videoExecDoc, apiKeyId: 'key-1' });

      expect(vi.mocked(buildSubagentToolConfig).mock.calls[0][0].videoConfig).toBeNull();
    });

    it('attaches new generation jobs to the run quest from onStatusUpdate', async () => {
      const { questRepository } = await import('@bike4mind/database');
      await runWithExecDoc(videoExecDoc);

      const toolCallbacks = buildSharedToolsMock.mock.calls[0][1] as {
        onStatusUpdate: (changes: Record<string, unknown>) => Promise<void>;
      };
      await toolCallbacks.onStatusUpdate({ generationJobs: [{ id: 'job-1', kind: 'music' }] });

      expect(questRepository.addGenerationJobs).toHaveBeenCalledWith('q-run', [{ id: 'job-1', kind: 'music' }]);
    });
  });

  describe('music_generation wiring', () => {
    const musicExecDoc = {
      ...execDoc,
      linkedQuestId: 'q-run',
      resolvedEnabledTools: ['music_generation'],
    };

    async function runWithExecDoc(doc: Record<string, unknown>) {
      const { agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce(doc as never);
      await runWithSession(baseSession);
    }

    it('offers the music tool to a run without an API key', async () => {
      const { buildSubagentToolConfig } = await import('./agentExecutor.subagentToolConfig');
      await runWithExecDoc(musicExecDoc);

      expect(vi.mocked(buildSubagentToolConfig).mock.calls[0][0].musicConfig).not.toBeNull();
    });

    it('caps songs on the run Quest with the limit resolved for the run org', async () => {
      const { buildSubagentToolConfig } = await import('./agentExecutor.subagentToolConfig');
      const { getAgentMusicToolConfigDeps } = await import('./agentExecutor.musicToolConfig');
      await runWithExecDoc({ ...musicExecDoc, organizationId: 'org-1' });

      const deps = vi.mocked(getAgentMusicToolConfigDeps).mock.results[0].value;
      expect(deps.resolveTrackLimit).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1' });
      const musicConfig = vi.mocked(buildSubagentToolConfig).mock.calls[0][0].musicConfig;
      await musicConfig!.createJob({ user: { id: 'user-1', organizationId: 'org-1' }, request: {}, source: 'agent' });
      expect(deps.slots.claim).toHaveBeenCalledWith('q-run', 2);
    });

    it('withholds the music tool from a run started with an API key', async () => {
      const { buildSubagentToolConfig } = await import('./agentExecutor.subagentToolConfig');
      await runWithExecDoc({ ...musicExecDoc, apiKeyId: 'key-1' });

      expect(vi.mocked(buildSubagentToolConfig).mock.calls[0][0].musicConfig).toBeNull();
    });
  });

  // Every iteration settles with an unconditional debit, so admission must require one whole
  // iteration's worth of credits, not merely a positive balance.
  describe('credit admission', () => {
    const pricedModel = {
      id: 'claude-sonnet-5',
      type: 'text',
      name: 'Sonnet',
      backend: 'anthropic',
      max_tokens: 64_000,
      contextWindow: 200_000,
      pricing: { 200000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } },
    };

    async function admitWith({ credits, doc = execDoc }: { credits: number; doc?: Record<string, unknown> }) {
      const { getAvailableModels } = await import('@bike4mind/llm-adapters');
      const { adminSettingsRepository, agentExecutionRepository, User } = await import('@bike4mind/database');
      vi.mocked(getAvailableModels).mockResolvedValueOnce([pricedModel] as never);
      vi.mocked(adminSettingsRepository.getSettingsValue).mockImplementation(
        (async (key: string) => key === 'enforceCredits') as never
      );
      vi.mocked(User.findById).mockResolvedValueOnce({ id: 'user-1', currentCredits: credits } as never);
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce(doc as never);
      const { handler } = await import('./agentExecutor');
      await handler(continuationEvent(), lambdaContext).catch(() => undefined);
      vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValue(false as never);
      return { markFailed: vi.mocked(agentExecutionRepository.markFailed) };
    }

    it('refuses a run whose balance cannot cover one iteration, before any tool or model work', async () => {
      const { markFailed } = await admitWith({ credits: 1 });

      expect(markFailed).toHaveBeenCalledWith('exec-1', { message: 'Insufficient credits to run agent execution' });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });

    it('admits a run whose balance covers one iteration', async () => {
      const { markFailed } = await admitWith({ credits: 100_000 });

      // The harness stops the run at tool building, which markFailed reports on its own terms.
      expect(markFailed).not.toHaveBeenCalledWith('exec-1', {
        message: 'Insufficient credits to run agent execution',
      });
      expect(buildSharedToolsMock).toHaveBeenCalledTimes(1);
    });

    // A resumed run prices its next request at the size of the last one it sent, so a long run
    // stops once its context outgrows the balance rather than once the balance hits zero.
    it('refuses a resumed run whose last request alone outruns the balance', async () => {
      const resumed = {
        ...execDoc,
        checkpoint: { iteration: 3, steps: [], turnUsage: [{ inputTokens: 150_000, outputTokens: 500 }] },
      };
      const { markFailed } = await admitWith({ credits: 1_000, doc: resumed });

      expect(markFailed).toHaveBeenCalledWith('exec-1', { message: 'Insufficient credits to run agent execution' });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });

    // Its children already spent from this balance; refusing the wake would strand their results.
    it('admits a DAG aggregation wake whose balance is short of a full iteration', async () => {
      const wake = {
        ...execDoc,
        status: 'awaiting_dag_children',
        dagSpec: { nodes: [] },
        waitingOnDagChildren: { toolUseId: 'tool-1' },
      };
      const { markFailed } = await admitWith({ credits: 1, doc: wake });

      expect(markFailed).not.toHaveBeenCalledWith('exec-1', {
        message: 'Insufficient credits to run agent execution',
      });
    });
  });

  describe('model access and subagent billing', () => {
    const runModel = { id: 'claude-sonnet-5', type: 'text', name: 'Sonnet', backend: 'anthropic' };

    async function runWithModels(models: unknown[], configurations?: unknown[]) {
      const { getAvailableModels } = await import('@bike4mind/llm-adapters');
      const { adminSettingsRepository, agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(getAvailableModels).mockResolvedValueOnce(models as never);
      if (configurations) {
        vi.mocked(adminSettingsRepository.findOne).mockResolvedValueOnce({ settingValue: configurations } as never);
      }
      const { handler } = await import('./agentExecutor');
      await handler(continuationEvent(), lambdaContext).catch(() => undefined);
      return { markFailed: vi.mocked(agentExecutionRepository.markFailed) };
    }

    it('refuses a run on a disabled model before any tool or model work', async () => {
      const { markFailed } = await runWithModels([{ ...runModel, disabled: true }]);

      expect(markFailed).toHaveBeenCalledWith('exec-1', {
        message: 'Model "claude-sonnet-5" is not available to this user',
      });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });

    it('fails a run whose model the catalog no longer carries instead of throwing', async () => {
      const { getLlmByModel } = await import('@bike4mind/llm-adapters');
      vi.mocked(getLlmByModel).mockReturnValueOnce(null);
      const { markFailed } = await runWithModels([]);

      expect(markFailed).toHaveBeenCalledWith('exec-1', {
        message: 'Model "claude-sonnet-5" is no longer available. Choose a different model for this agent.',
      });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });

    it('refuses a run on a model gated to a tag the user does not hold', async () => {
      const { markFailed } = await runWithModels(
        [runModel],
        [{ id: 'claude-sonnet-5', enabled: true, allowedUserTags: ['pro'] }]
      );

      expect(markFailed).toHaveBeenCalledWith('exec-1', {
        message: 'Model "claude-sonnet-5" is not available to this user',
      });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });

    it('offers delegation only the models this user may run', async () => {
      await runWithModels([runModel, { ...runModel, id: 'paused-model', disabled: true }]);

      const deps = buildSharedToolsMock.mock.calls[0][0] as { subagentModels: Array<{ id: string }> };
      expect(deps.subagentModels.map(m => m.id)).toEqual(['claude-sonnet-5']);
    });

    async function subagentTracker() {
      await runWithModels([runModel]);
      return (buildSharedToolsMock.mock.calls[0][1] as { subagentTracker: ServerSubagentTracker }).subagentTracker;
    }

    const childResult = {
      agentName: 'researcher',
      model: 'claude-sonnet-5',
      finalAnswer: 'found it',
      steps: [],
      completionInfo: {
        totalCredits: 7,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalTokens: 15,
        iterations: 1,
        toolCalls: 0,
        reachedMaxIterations: false,
      },
    } as unknown as Parameters<ServerSubagentTracker['onComplete']>[0]['result'];

    it("charges an in-process subagent's tokens to the run's payer", async () => {
      const tracker = await subagentTracker();
      await tracker.onComplete({ childExecutionId: 'child-1', result: childResult });

      expect(deductCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text_generation_usage',
          user: expect.objectContaining({ id: 'user-1' }),
          credits: 7,
          model: 'claude-sonnet-5',
          inputTokens: 10,
          outputTokens: 5,
          questId: 'quest-1',
        }),
        expect.anything()
      );
    });

    it("charges a timed-out in-process subagent's partial spend", async () => {
      const tracker = await subagentTracker();
      await tracker.onFailure({
        childExecutionId: 'child-1',
        error: 'aborted',
        isTimeout: true,
        partialResult: childResult,
      });

      expect(deductCreditsMock).toHaveBeenCalledWith(expect.objectContaining({ credits: 7 }), expect.anything());
    });

    // The orchestrator swallows a throw from these hooks, so a charge placed after the terminal
    // write would be lost whenever that write failed.
    it('charges an in-process subagent even when its completion write fails', async () => {
      const { agentExecutionRepository } = await import('@bike4mind/database');
      const tracker = await subagentTracker();
      vi.mocked(agentExecutionRepository.markComplete).mockRejectedValueOnce(new Error('db down'));

      await expect(tracker.onComplete({ childExecutionId: 'child-1', result: childResult })).rejects.toThrow('db down');

      expect(deductCreditsMock).toHaveBeenCalledWith(expect.objectContaining({ credits: 7 }), expect.anything());
    });

    it('charges a failed in-process subagent even when its failure write fails', async () => {
      const { agentExecutionRepository } = await import('@bike4mind/database');
      const tracker = await subagentTracker();
      vi.mocked(agentExecutionRepository.markFailed).mockRejectedValueOnce(new Error('db down'));

      await expect(
        tracker.onFailure({ childExecutionId: 'child-1', error: 'boom', isTimeout: false, partialResult: childResult })
      ).rejects.toThrow('db down');

      expect(deductCreditsMock).toHaveBeenCalledWith(expect.objectContaining({ credits: 7 }), expect.anything());
    });

    // The client clears a child's live-text buffer on each of these frames, so a delta that lands
    // after one would bring stale "(streaming...)" text back under a finished child.
    describe('live text deltas land before the frame that clears them', () => {
      const delta = { childExecutionId: 'child-1', agentName: 'researcher', iteration: 0, delta: 'hello' };

      const heldDeltaFrame = expect.objectContaining({
        action: 'subagent_text_delta',
        executionId: 'exec-1',
        childExecutionId: 'child-1',
        agentName: 'researcher',
        iteration: 0,
        delta: 'hello',
      });

      // `awaitCreditsWrite` is for terminal handlers whose last awaited call before their own send is
      // the credits write. Their mocked work all resolves on the microtask queue, so once that call
      // has happened one macrotask turn lets the handler reach its send (or its flush): a missing
      // flush then shows up as the terminal frame going out while the delta is still held.
      async function withDeltaInFlight(
        sendTerminal: (tracker: ServerSubagentTracker) => Promise<void>,
        { awaitCreditsWrite = false } = {}
      ) {
        const { agentExecutionRepository } = await import('@bike4mind/database');
        const tracker = await subagentTracker();
        let release!: () => void;
        ws.holdTextDelta = new Promise<void>(resolve => {
          release = resolve;
        });
        ws.frames.length = 0;
        vi.mocked(agentExecutionRepository.incrementCreditsUsed).mockClear();

        const delivered = tracker.onTextDelta!(delta);
        const terminal = sendTerminal(tracker);
        if (awaitCreditsWrite) {
          await vi.waitFor(() => expect(agentExecutionRepository.incrementCreditsUsed).toHaveBeenCalled());
        }
        await new Promise(resolve => setImmediate(resolve));
        const beforeRelease = ws.frames.map(frame => frame.action);

        release();
        await Promise.all([delivered, terminal]);
        return { beforeRelease, afterRelease: [...ws.frames] };
      }

      it('sends subagent_iteration_step only after the child queued deltas', async () => {
        const { beforeRelease, afterRelease } = await withDeltaInFlight(tracker =>
          tracker.onStep({
            childExecutionId: 'child-1',
            agentName: 'researcher',
            iteration: 0,
            step: { type: 'thought', content: 'done', timestamp: 0 } as never,
          })
        );

        expect(beforeRelease).not.toContain('subagent_iteration_step');
        expect(afterRelease).toEqual([
          heldDeltaFrame,
          expect.objectContaining({
            action: 'subagent_iteration_step',
            executionId: 'exec-1',
            childExecutionId: 'child-1',
            agentName: 'researcher',
            iteration: 0,
            step: expect.objectContaining({ content: 'done' }),
          }),
        ]);
      });

      it('sends subagent_completed only after the child queued deltas', async () => {
        const { beforeRelease, afterRelease } = await withDeltaInFlight(
          tracker => tracker.onComplete({ childExecutionId: 'child-1', result: childResult }),
          { awaitCreditsWrite: true }
        );

        expect(beforeRelease).not.toContain('subagent_completed');
        expect(afterRelease).toEqual([
          heldDeltaFrame,
          expect.objectContaining({
            action: 'subagent_completed',
            executionId: 'exec-1',
            childExecutionId: 'child-1',
            agentName: 'researcher',
            finalAnswer: 'found it',
          }),
        ]);
      });

      it('sends subagent_failed only after the child queued deltas', async () => {
        const { beforeRelease, afterRelease } = await withDeltaInFlight(
          tracker =>
            tracker.onFailure({
              childExecutionId: 'child-1',
              error: 'boom',
              isTimeout: false,
              partialResult: childResult,
            }),
          { awaitCreditsWrite: true }
        );

        expect(beforeRelease).not.toContain('subagent_failed');
        expect(afterRelease).toEqual([
          heldDeltaFrame,
          expect.objectContaining({
            action: 'subagent_failed',
            executionId: 'exec-1',
            childExecutionId: 'child-1',
            error: 'Subagent execution failed',
            isTimeout: false,
          }),
        ]);
      });
    });

    // Reached only by spend no tracker bills, e.g. a subagent that ran untracked after
    // `tracker.onStart` failed.
    it('charges untracked subagent spend reported through onSubagentCredits', async () => {
      await runWithModels([runModel]);
      const callbacks = buildSharedToolsMock.mock.calls[0][1] as {
        onSubagentCredits: (
          credits: number,
          meta?: { model: string; inputTokens: number; outputTokens: number }
        ) => Promise<void>;
      };

      await callbacks.onSubagentCredits(4, { model: 'claude-sonnet-5', inputTokens: 2, outputTokens: 1 });

      expect(deductCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text_generation_usage',
          credits: 4,
          model: 'claude-sonnet-5',
          inputTokens: 2,
          outputTokens: 1,
          questId: 'quest-1',
        }),
        expect.anything()
      );
    });

    describe('usage events', () => {
      const pricedModel = { ...runModel, pricing: { 200000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } } };

      async function pricedTracker() {
        await runWithModels([pricedModel]);
        return (buildSharedToolsMock.mock.calls[0][1] as { subagentTracker: ServerSubagentTracker }).subagentTracker;
      }

      const usageRecord = async () => {
        const { usageEventRepository } = await import('@bike4mind/database');
        return vi.mocked(usageEventRepository.record);
      };

      it('records a usage event for a tracked in-process subagent, as the in-chat path does', async () => {
        const tracker = await pricedTracker();
        await tracker.onComplete({ childExecutionId: 'child-1', result: childResult });

        const record = await usageRecord();
        expect(record).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            requestId: 'quest-1',
            userId: 'user-1',
            feature: 'tool',
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            inputTokens: 10,
            outputTokens: 5,
            creditsCharged: 7,
          })
        );
        expect(record.mock.calls[0][0].costUsd).toBeCloseTo(10 * 3e-6 + 5 * 15e-6, 12);
      });

      it("records a timed-out in-process subagent's partial spend", async () => {
        const tracker = await pricedTracker();
        await tracker.onFailure({
          childExecutionId: 'child-1',
          error: 'aborted',
          isTimeout: true,
          partialResult: childResult,
        });

        expect(await usageRecord()).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ feature: 'tool', creditsCharged: 7, inputTokens: 10, outputTokens: 5 })
        );
      });

      it('records untracked subagent spend from the priced usage onSubagentCredits reports', async () => {
        await runWithModels([pricedModel]);
        const callbacks = buildSharedToolsMock.mock.calls[0][1] as {
          onSubagentCredits: (credits: number, meta: Record<string, unknown>) => Promise<void>;
        };

        await callbacks.onSubagentCredits(4, {
          usdCost: 0.002,
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        });

        expect(await usageRecord()).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ creditsCharged: 4, costUsd: 0.002, inputTokens: 2, cachedInputTokens: 3 })
        );
      });

      it('records nothing for a subagent that stopped before its first model call', async () => {
        const tracker = await pricedTracker();
        const idle = {
          ...childResult,
          completionInfo: { ...childResult.completionInfo, totalCredits: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        };
        await tracker.onComplete({ childExecutionId: 'child-1', result: idle });

        expect(await usageRecord()).not.toHaveBeenCalled();
        expect(deductCreditsMock).not.toHaveBeenCalled();
      });
    });

    it('refuses a run when the model configurations cannot be read', async () => {
      const { adminSettingsRepository } = await import('@bike4mind/database');
      vi.mocked(adminSettingsRepository.findOne).mockRejectedValueOnce(new Error('settings down'));

      const { markFailed } = await runWithModels([runModel]);

      expect(markFailed).toHaveBeenCalledWith('exec-1', {
        message: 'Unable to load model configuration. Please retry.',
      });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });

    it('preserves an aggregation-only wake when model configuration cannot be read', async () => {
      const { adminSettingsRepository, agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(adminSettingsRepository.findOne).mockRejectedValueOnce(new Error('settings down'));
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce({
        ...execDoc,
        status: 'awaiting_dag_children',
        dagSpec: { nodes: [] },
        waitingOnDagChildren: { toolUseId: 'tool-1' },
      } as never);

      const { markFailed } = await runWithModels([runModel]);

      expect(markFailed).not.toHaveBeenCalledWith('exec-1', {
        message: 'Unable to load model configuration. Please retry.',
      });
      expect(buildSharedToolsMock).toHaveBeenCalledTimes(1);
    });
  });

  // In-process subagents never pass `processSubagentDispatch`'s admission, so the delegation
  // itself checks the payer's live balance.
  describe('in-process subagent balance admission', () => {
    const pricedModel = {
      id: 'claude-sonnet-5',
      type: 'text',
      name: 'Sonnet',
      backend: 'anthropic',
      max_tokens: 64_000,
      contextWindow: 200_000,
      pricing: { 200000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } },
    };

    async function toolDepsWith(enforceCredits: boolean) {
      const { getAvailableModels } = await import('@bike4mind/llm-adapters');
      const { adminSettingsRepository, User } = await import('@bike4mind/database');
      vi.mocked(getAvailableModels).mockResolvedValueOnce([pricedModel] as never);
      // Enough to pass the run's own admission.
      vi.mocked(User.findById).mockResolvedValueOnce({ id: 'user-1', currentCredits: 100_000 } as never);
      vi.mocked(adminSettingsRepository.getSettingsValue).mockImplementation(
        (async (key: string) => key === 'enforceCredits' && enforceCredits) as never
      );
      try {
        return (await runWithSession(baseSession)) as {
          checkInsufficientCredits?: (model: string) => Promise<boolean>;
        };
      } finally {
        vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValue(false as never);
      }
    }

    it("refuses a delegation the payer's live balance cannot start when credits are enforced", async () => {
      const { userRepository } = await import('@bike4mind/database');
      const deps = await toolDepsWith(true);
      const findUser = vi.spyOn(userRepository, 'findById').mockResolvedValueOnce({ currentCredits: 1 } as never);

      await expect(deps.checkInsufficientCredits!('claude-sonnet-5')).resolves.toBe(true);
      expect(findUser).toHaveBeenCalledWith('user-1');
    });

    it('rechecks the organization that pays for the run rather than the personal wallet', async () => {
      const { agentExecutionRepository, organizationRepository, userRepository } = await import('@bike4mind/database');
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce({
        ...execDoc,
        organizationId: 'org-1',
      } as never);
      vi.mocked(organizationRepository.findById).mockResolvedValueOnce({
        id: 'org-1',
        currentCredits: 100_000,
      } as never);
      const deps = await toolDepsWith(true);
      vi.mocked(organizationRepository.findById)
        .mockClear()
        .mockResolvedValueOnce({ currentCredits: 1 } as never);
      const findUser = vi.spyOn(userRepository, 'findById').mockResolvedValue({ currentCredits: 100_000 } as never);
      findUser.mockClear();

      await expect(deps.checkInsufficientCredits!('claude-sonnet-5')).resolves.toBe(true);

      expect(organizationRepository.findById).toHaveBeenCalledExactlyOnceWith('org-1');
      expect(findUser).not.toHaveBeenCalled();
    });

    it('is not wired when credits are not enforced', async () => {
      const deps = await toolDepsWith(false);

      expect(deps.checkInsufficientCredits).toBeUndefined();
    });
  });

  it('resolves an unset library flag to included for a session with no explicit lake scope', async () => {
    const deps = await runWithSession(baseSession);

    expect(deps.sessionIncludeLibraryFiles).toBe(true);
  });

  it('resolves a stored false to included when Data Lakes is off', async () => {
    const deps = await runWithSession({ ...baseSession, includeLibraryFiles: false, forceKnowledgeRetrieval: false });

    expect(deps.sessionIncludeLibraryFiles).toBe(true);
  });

  describe('contributed workspace session settings', () => {
    it('withholds delegation when the workspace resolves integrations off', async () => {
      resolveWorkspaceSettings.mockResolvedValue({ disableUserIntegrations: true });
      const deps = await runWithSession({
        ...baseSession,
        surface: 'settings-workspace',
        disableUserIntegrations: false,
      });

      expect(resolveWorkspaceSettings).toHaveBeenCalledTimes(1);
      expect(deps.agentStore).toBeUndefined();
    });

    it('drops a baked integrations opt-out the workspace no longer resolves', async () => {
      resolveWorkspaceSettings.mockResolvedValue({});
      const deps = await runWithSession({ ...baseSession, surface: 'settings-workspace' });

      expect(deps.agentStore).toBeDefined();
    });

    it('fails closed when the resolver throws: the run never reaches tool building', async () => {
      resolveWorkspaceSettings.mockRejectedValue(new Error('workspace lookup failed'));
      const { sessionRepository, agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(sessionRepository.findById).mockResolvedValue({
        ...baseSession,
        surface: 'settings-workspace',
        disableUserIntegrations: false,
      } as never);
      const { handler } = await import('./agentExecutor');

      await expect(handler(continuationEvent(), lambdaContext)).resolves.toEqual({ batchItemFailures: [] });

      expect(resolveWorkspaceSettings).toHaveBeenCalledTimes(1);
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
      expect(agentExecutionRepository.markFailed).toHaveBeenCalledExactlyOnceWith(
        'exec-1',
        expect.objectContaining({
          message: 'Workspace session settings resolver for "settings-workspace" failed',
        })
      );
    });

    it('refuses a run on a workspace that answers its own turns, before any tool or model work', async () => {
      const { sessionRepository, agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(sessionRepository.findById).mockResolvedValue({
        ...baseSession,
        surface: 'responding-workspace',
      } as never);
      const { handler } = await import('./agentExecutor');

      await expect(handler(continuationEvent(), lambdaContext)).resolves.toEqual({ batchItemFailures: [] });

      expect(buildSharedToolsMock).not.toHaveBeenCalled();
      expect(agentExecutionRepository.markFailed).toHaveBeenCalledExactlyOnceWith('exec-1', {
        message: 'This workspace answers its own turns, so agent runs are not available in it',
      });
    });

    it('keeps the stored flag on a session outside any contributed workspace', async () => {
      const deps = await runWithSession(baseSession);

      expect(resolveWorkspaceSettings).not.toHaveBeenCalled();
      expect(deps.agentStore).toBeUndefined();
    });
  });

  describe('agent extensions', () => {
    async function registry() {
      const { executorAgentExtensions } = await import('./agentExecutor.agentExtensions');
      return {
        resolve: vi.mocked(executorAgentExtensions.resolveSurfaceProfile),
        guard: vi.mocked(executorAgentExtensions.applyToolMapGuards),
      };
    }

    it('resolves the surface profile on a continuation, then guards the contributed tools', async () => {
      const { resolve, guard } = await registry();
      guard.mockImplementationOnce(
        tools =>
          Object.fromEntries(
            Object.entries(tools).map(([k, t]) => [k, { ...(t as object), guarded: true }])
          ) as typeof tools
      );
      await runWithSession({ ...baseSession, surface: OPTI_SURFACE });

      expect(resolve).toHaveBeenCalledWith(
        OPTI_SURFACE,
        expect.objectContaining({ executionId: 'exec-1', contributedToolNames: ['fixture_tool'] })
      );
      const profile = resolve.mock.results[0].value;
      expect(profile.id).toBe('synthetic:opti-orchestration');
      expect(profile.allowedTools).toContain('fixture_tool');

      expect(guard).toHaveBeenCalledTimes(1);
      expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(guard.mock.invocationCallOrder[0]);
      const [tools, ctx] = guard.mock.calls[0];
      expect(Object.keys(tools)).toEqual(['fixture_tool']);
      expect(ctx).toEqual(expect.objectContaining({ executionId: 'exec-1', runState: expect.any(Object) }));
      const guarded = guard.mock.results[0].value;
      const { externalTools, enabledTools, sessionDisabledTools } = buildSharedToolsMock.mock.calls[0][2] as {
        externalTools: Record<string, unknown>;
        enabledTools: string[];
        sessionDisabledTools: string[];
      };
      expect(externalTools.fixture_tool).toBe(guarded.fixture_tool);
      expect(externalTools.fixture_tool).not.toBe(tools.fixture_tool);
      expect(externalTools.fixture_tool).toHaveProperty('guarded', true);
      // The resolved profile, not the execution doc, is what shapes the toolbelt: its denials reach the build.
      expect(sessionDisabledTools).toEqual(expect.arrayContaining(profile.deniedTools));
      expect(enabledTools).toContain('fixture_tool');
    });

    it('preserves a pinned agent and its denials through a continuation on a contributed surface', async () => {
      const { resolve, guard } = await registry();
      const { sessionRepository, agentRepository, agentExecutionRepository, adminSettingsRepository } =
        await import('@bike4mind/database');
      const session = { ...baseSession, surface: 'fixture-surface', disableUserIntegrations: false };
      vi.mocked(sessionRepository.findById).mockResolvedValue(session as never);
      const pinnedDenials = ['web_search', 'fixture__write', 'delegate_to_agent', 'coordinate_task'];
      const findAgent = vi.spyOn(agentRepository, 'findById').mockResolvedValue({
        id: 'agent-1',
        name: 'Pinned agent',
        allowedTools: ['fixture_tool', 'web_search'],
        deniedTools: pinnedDenials,
      } as never);
      // Only a new execution resolves memento gates; the continuation-only harness never mocked it.
      const persistGates = vi
        .spyOn(agentExecutionRepository, 'persistResolvedMementoGates')
        .mockResolvedValue(undefined as never);
      vi.mocked(adminSettingsRepository.getSettingsValue).mockImplementation((async (key: string) =>
        key === 'orchestrationDefaults' ? undefined : false) as never);
      const { handler } = await import('./agentExecutor');
      const start = {
        executionId: 'exec-1',
        userId: 'user-1',
        sessionId: 'session-1',
        query: 'q',
        model: 'claude-sonnet-5',
        connectionId: 'conn-1',
        agentId: 'agent-1',
      };
      await handler(start as never, lambdaContext).catch(() => undefined);
      vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValue(false as never);
      findAgent.mockRestore();
      persistGates.mockRestore();

      expect(buildSharedToolsMock).toHaveBeenCalledTimes(1);
      expect(resolve).not.toHaveBeenCalled();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(agentExecutionRepository.persistProfileDeniedTools).toHaveBeenCalledExactlyOnceWith(
        'exec-1',
        pinnedDenials,
        true
      );
      const [, persistedDenials, profileIsPinned] = vi.mocked(agentExecutionRepository.persistProfileDeniedTools).mock
        .calls[0];
      const [, persistedTools] = vi.mocked(agentExecutionRepository.persistResolvedEnabledTools).mock.calls[0];
      vi.clearAllMocks();
      vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce({
        ...execDoc,
        profileIsPinned,
        profileDeniedTools: persistedDenials,
        resolvedEnabledTools: persistedTools,
      } as never);

      const deps = await runWithSession(session);

      expect(resolve).not.toHaveBeenCalled();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(deps.agentStore).toBeUndefined();
      expect(deps.dagDispatcher).toBeUndefined();
      const options = buildSharedToolsMock.mock.calls[0][2];
      expect(options.enabledTools).toContain('fixture_tool');
      expect(options.enabledTools).not.toContain('web_search');
      expect(options.sessionDisabledTools).toEqual(expect.arrayContaining(pinnedDenials));
    });

    it.each([undefined, false])(
      'keeps stored denials only for unknown legacy provenance (%s)',
      async profileIsPinned => {
        const { resolve } = await registry();
        const { agentExecutionRepository } = await import('@bike4mind/database');
        const persistedDenials = ['web_search', 'fixture__write', 'delegate_to_agent', 'coordinate_task'];
        vi.mocked(agentExecutionRepository.findById).mockResolvedValueOnce({
          ...execDoc,
          profileIsPinned,
          profileDeniedTools: persistedDenials,
          resolvedEnabledTools: ['fixture_tool', 'web_search'],
        } as never);

        const deps = await runWithSession({
          ...baseSession,
          surface: 'fixture-surface',
          disableUserIntegrations: false,
        });

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve.mock.results[0].value.deniedTools).toEqual([]);
        const options = buildSharedToolsMock.mock.calls[0][2];
        expect(options.enabledTools).toContain('fixture_tool');
        if (profileIsPinned === undefined) {
          expect(options.enabledTools).not.toContain('web_search');
          expect(options.sessionDisabledTools).toEqual(expect.arrayContaining(persistedDenials));
          expect(deps.agentStore).toBeUndefined();
          expect(deps.dagDispatcher).toBeUndefined();
        } else {
          expect(options.enabledTools).toContain('web_search');
          expect(options.sessionDisabledTools).toEqual([]);
          expect(deps.agentStore).toBeDefined();
          expect(deps.dagDispatcher).toBeDefined();
        }
      }
    );

    it('records an unpinned surface profile for later continuations', async () => {
      const { resolve } = await registry();
      const { sessionRepository, agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(sessionRepository.findById).mockResolvedValue({ ...baseSession, surface: 'fixture-surface' } as never);
      const persistGates = vi
        .spyOn(agentExecutionRepository, 'persistResolvedMementoGates')
        .mockResolvedValue(undefined as never);
      try {
        const { handler } = await import('./agentExecutor');
        await handler(
          {
            executionId: 'exec-1',
            userId: 'user-1',
            sessionId: 'session-1',
            query: 'q',
            model: 'claude-sonnet-5',
            connectionId: 'conn-1',
          },
          lambdaContext
        );
      } finally {
        persistGates.mockRestore();
      }

      expect(buildSharedToolsMock).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(agentExecutionRepository.persistProfileDeniedTools).toHaveBeenCalledExactlyOnceWith('exec-1', [], false);
    });

    it('falls through to the default profile on a surface with none registered, still guarding tools', async () => {
      const { resolve, guard } = await registry();
      await runWithSession({ ...baseSession, surface: 'unregistered-surface' });

      expect(resolve.mock.results[0].value).toBeUndefined();
      expect(guard).toHaveBeenCalledTimes(1);
    });
  });

  describe('restricted tier', () => {
    const model = (id: string, backend: string) => ({
      id,
      type: 'text',
      name: id,
      backend,
      max_tokens: 64_000,
      contextWindow: 200_000,
      pricing: { 200000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } },
    });
    const premium = model('claude-sonnet-5', 'anthropic');
    const cheap = model('cheap-model', 'gemini');

    async function runRestricted({ capReached = false, user = {} as Record<string, unknown> } = {}) {
      const { getAvailableModels, getLlmByModel } = await import('@bike4mind/llm-adapters');
      const { User, cacheRepository, agentExecutionRepository } = await import('@bike4mind/database');
      vi.mocked(getAvailableModels).mockResolvedValueOnce([premium, cheap] as never);
      vi.mocked(User.findById).mockResolvedValueOnce({
        id: 'user-1',
        currentCredits: 100,
        throttle: { tier: 'shadow' },
        ...user,
      } as never);
      vi.mocked(cacheRepository.tryAddWithinLimitFixedWindow).mockResolvedValue({
        success: !capReached,
        count: 1,
        expiresAt: new Date(),
      } as never);
      const { handler } = await import('./agentExecutor');
      await handler(continuationEvent(), lambdaContext).catch(() => undefined);
      return {
        llmModels: vi
          .mocked(getLlmByModel)
          .mock.calls.map(call => (call[1] as { modelInfo?: { id: string } }).modelInfo?.id),
        markFailed: vi.mocked(agentExecutionRepository.markFailed),
        counter: vi.mocked(cacheRepository.tryAddWithinLimitFixedWindow),
      };
    }

    it('builds the backend and tools on the allowlisted model', async () => {
      const { llmModels, counter } = await runRestricted();

      expect(llmModels).toEqual(['cheap-model']);
      const deps = buildSharedToolsMock.mock.calls[0][0] as Record<string, unknown>;
      expect(deps.model).toBe('cheap-model');
      expect((deps.subagentModels as Array<{ id: string }>).map(m => m.id)).toEqual(['cheap-model']);
      expect(counter).toHaveBeenCalledWith(
        expect.stringMatching(/^shadow-tokens:user-1:/),
        1,
        20000,
        expect.any(Number)
      );
    });

    it('records tool usage under the requested model', async () => {
      await runRestricted();
      const { toLedgerModel } = buildSharedToolsMock.mock.calls[0][0] as { toLedgerModel: (id: string) => string };

      expect(toLedgerModel('cheap-model')).toBe('claude-sonnet-5');
      expect(toLedgerModel('gpt-4')).toBe('gpt-4');
    });

    it('has current_model_details report the requested model, not the substitute', async () => {
      await runRestricted();
      const { servingModel } = buildSharedToolsMock.mock.calls[0][0] as { servingModel?: { current: { id: string } } };

      expect(servingModel?.current.id).toBe('claude-sonnet-5');
    });

    it('counts untracked subagent cache tokens toward the daily cap, as chat does', async () => {
      const { counter } = await runRestricted();
      const { onSubagentCredits } = buildSharedToolsMock.mock.calls[0][1] as {
        onSubagentCredits: (
          credits: number,
          meta?: {
            model: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          }
        ) => Promise<void>;
      };
      counter.mockClear();

      await onSubagentCredits(4, {
        model: 'cheap-model',
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      });

      expect(counter).toHaveBeenCalledWith(
        expect.stringMatching(/^shadow-tokens:user-1:/),
        18,
        Number.MAX_SAFE_INTEGER,
        expect.any(Number)
      );
    });

    it('runs deep_research on the substitute, with no OpenAI key to swap it onto GPT-4.1', async () => {
      const { buildSubagentToolConfig } = await import('./agentExecutor.subagentToolConfig');
      await runRestricted();
      await runRestricted({ user: { isAdmin: true } });

      const [restricted, admin] = vi.mocked(buildSubagentToolConfig).mock.calls.map(call => call[0]);
      expect(restricted).toMatchObject({ model: 'cheap-model', apiKeyTable: undefined });
      expect(admin).toMatchObject({ model: 'claude-sonnet-5' });
      expect(admin.apiKeyTable).toBeDefined();
    });

    it('names the requested model for the identity reminder only when substituted', async () => {
      const { ReActAgent } = await import('@bike4mind/agents');
      const contexts: Array<Record<string, unknown>> = [];
      const on = vi.spyOn(ReActAgent.prototype, 'on').mockImplementation(function (this: unknown) {
        // any: reads the private AgentContext the constructor stored
        contexts.push((this as { context: Record<string, unknown> }).context);
        return this as never;
      });
      buildSharedToolsMock.mockImplementation(() => []);
      try {
        await runRestricted();
        await runRestricted({ user: { isAdmin: true } });
      } finally {
        on.mockRestore();
      }

      expect(contexts[0]).toMatchObject({ model: 'cheap-model', modelIdentityId: 'claude-sonnet-5' });
      expect(contexts[contexts.length - 1]).not.toHaveProperty('modelIdentityId');
    });

    it('runs an admin on the requested model and reads no counter', async () => {
      const { llmModels, counter } = await runRestricted({ user: { isAdmin: true } });

      expect(llmModels).toEqual(['claude-sonnet-5']);
      expect(counter).not.toHaveBeenCalled();
    });

    it('persists a subagent started on the substitute under the requested model', async () => {
      const { agentExecutionRepository } = await import('@bike4mind/database');
      const create = vi.spyOn(agentExecutionRepository, 'create').mockResolvedValueOnce({ id: 'child-1' } as never);
      vi.spyOn(agentExecutionRepository, 'addChildExecution').mockResolvedValueOnce(undefined as never);
      await runRestricted();
      const { subagentTracker } = buildSharedToolsMock.mock.calls[0][1] as { subagentTracker: ServerSubagentTracker };

      await subagentTracker.onStart({
        task: 't',
        agentName: 'researcher',
        model: 'cheap-model',
        isBackground: false,
      } as Parameters<ServerSubagentTracker['onStart']>[0]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));
    });

    it('charges untracked subagent spend under the requested model', async () => {
      await runRestricted();
      const { onSubagentCredits } = buildSharedToolsMock.mock.calls[0][1] as {
        onSubagentCredits: (
          credits: number,
          meta?: { model: string; inputTokens: number; outputTokens: number }
        ) => Promise<void>;
      };

      await onSubagentCredits(4, { model: 'cheap-model', inputTokens: 2, outputTokens: 1 });

      expect(deductCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({ credits: 4, model: 'claude-sonnet-5' }),
        expect.anything()
      );
    });

    it('over the daily token cap fails like an out-of-credits run', async () => {
      const { markFailed } = await runRestricted({ capReached: true });

      expect(markFailed).toHaveBeenCalledWith('exec-1', { message: 'Insufficient credits to run agent execution' });
      expect(buildSharedToolsMock).not.toHaveBeenCalled();
    });
  });
});
