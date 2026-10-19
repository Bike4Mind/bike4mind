import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ServerSubagentTracker } from '@bike4mind/services/llm';

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

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send() {
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

vi.mock('@server/utils/storage', () => ({
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

vi.mock('@server/utils/persistRunAsQuest', () => ({ persistRunAsQuest: vi.fn().mockResolvedValue(undefined) }));

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
});
