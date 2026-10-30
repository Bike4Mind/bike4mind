import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import type { Context } from 'aws-lambda';

// `processSubagentDispatch` admission and billing: a dispatched subagent (or DAG node) runs
// only on a model its user may run and a balance that covers its first iteration, and its
// own token spend - plus that of any subagent it delegates in-process - is charged to the
// payer's wallet. Harness mirrors agentExecutor.abortDeadline.test.ts.

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

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn().mockResolvedValue([]) }));

// Model admission reads admin settings from the real repository; these tests exercise other gates.
const admissionAssertMock = vi.fn(async (_model: string) => {});
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({
    admits: async () => true,
    assert: (model: string) => admissionAssertMock(model),
  }),
}));

const onDagNodeTerminalMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./agentExecutorDag', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutorDag')>('./agentExecutorDag');
  return { ...actual, onDagNodeTerminal: (...args: unknown[]) => onDagNodeTerminalMock(...args) };
});

const testModel = {
  id: 'test-model',
  type: 'text',
  name: 'Test',
  backend: 'anthropic',
  max_tokens: 64_000,
  contextWindow: 200_000,
  pricing: { 200000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } },
};

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([testModel]),
    getLlmByModel: vi.fn().mockReturnValue({ currentModel: '' }),
  };
});

const shadowRoutingMock = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services/llm/shadowTier', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm/shadowTier')>(
    '@bike4mind/services/llm/shadowTier'
  );
  return {
    ...actual,
    resolveShadowRouting: (...args: unknown[]) => shadowRoutingMock(...args),
    reserveShadowTokenBudget: vi.fn().mockResolvedValue(true),
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

const delegateToAgentMock = vi.fn();
const buildSharedToolsMock = vi.fn().mockReturnValue([]);
vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  class MockOrchestrator {
    constructor(public deps: unknown) {}
    delegateToAgent(...args: unknown[]) {
      return delegateToAgentMock(...args);
    }
  }
  return {
    ...actual,
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    buildSharedTools: (...args: unknown[]) => buildSharedToolsMock(...args),
    ServerSubagentOrchestrator: MockOrchestrator,
    // The real one reads a private symbol the orchestrator sets; the mock orchestrator throws `spent`.
    spentResultOf: (err: unknown) => (err as { spent?: unknown } | undefined)?.spent,
  };
});

const childDoc = {
  id: 'child-1',
  status: 'pending',
  abortedAt: null,
  userId: 'user-1',
  sessionId: 'session-1',
  questId: 'quest-1',
  organizationId: null,
  parentExecutionId: 'parent-1',
  dagNodeId: 'node-b',
  model: 'test-model',
  subagentConfig: { agentName: 'researcher', thoroughness: 'quick' },
};

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  const repo = actual.agentExecutionRepository;
  vi.spyOn(repo, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(repo, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(repo, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'markFailed').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'markAborted').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'markComplete').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'incrementCreditsUsed').mockResolvedValue(undefined as never);
  vi.spyOn(repo, 'checkAbortFlag').mockResolvedValue(false as never);
  vi.spyOn(actual.usageEventRepository, 'record').mockResolvedValue(undefined as never);
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100_000 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue({
    id: 'session-1',
    userId: 'user-1',
    disableUserIntegrations: true,
  } as never);
  vi.spyOn(actual.agentRepository, 'listForUser').mockResolvedValue([] as never);
  vi.spyOn(actual.adminSettingsRepository, 'getSettingsValue').mockResolvedValue(false as never);
  vi.spyOn(actual.adminSettingsRepository, 'findOne').mockResolvedValue(null as never);
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

function dagNodeDispatchEvent() {
  return {
    Records: [
      {
        messageId: 'msg-1',
        body: JSON.stringify({
          kind: 'dag_node_dispatch',
          childExecutionId: 'child-1',
          connectionId: 'conn-1',
          dagNodeId: 'node-b',
        }),
      },
    ],
  } as never;
}

const context = { getRemainingTimeInMillis: () => 600_000 } as unknown as Context;

const childResult = {
  agentName: 'researcher',
  model: 'test-model',
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
};

async function dispatch() {
  const { handler } = await import('./agentExecutor');
  await handler(dagNodeDispatchEvent(), context);
  const { agentExecutionRepository } = await import('@bike4mind/database');
  return { markFailed: vi.mocked(agentExecutionRepository.markFailed) };
}

describe('processSubagentDispatch admission and billing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    shadowRoutingMock.mockResolvedValue({ settings: null, modelInfo: undefined });
    delegateToAgentMock.mockResolvedValue(childResult);
    const { getAvailableModels } = await import('@bike4mind/llm-adapters');
    vi.mocked(getAvailableModels).mockResolvedValue([testModel] as never);
  });

  it("charges a completed subagent's token spend to the payer's wallet", async () => {
    await dispatch();

    expect(deductCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text_generation_usage',
        user: expect.objectContaining({ id: 'user-1' }),
        credits: 7,
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 5,
        questId: 'quest-1',
      }),
      expect.anything()
    );
  });

  it('charges what a subagent spent before it failed', async () => {
    delegateToAgentMock.mockRejectedValue(Object.assign(new Error('provider 500'), { spent: childResult }));

    await dispatch();

    expect(deductCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text_generation_usage', credits: 7, inputTokens: 10, outputTokens: 5 }),
      expect.anything()
    );
    const { agentExecutionRepository } = await import('@bike4mind/database');
    expect(agentExecutionRepository.incrementCreditsUsed).toHaveBeenCalledExactlyOnceWith('child-1', 7);
    expect(vi.mocked(agentExecutionRepository.incrementCreditsUsed).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(agentExecutionRepository.markFailed).mock.invocationCallOrder[0]
    );
  });

  it('charges the spend of a subagent this one delegates in-process', async () => {
    await dispatch();
    const callbacks = buildSharedToolsMock.mock.calls[0][1] as {
      onSubagentCredits: (credits: number, meta?: { model: string; inputTokens: number; outputTokens: number }) => void;
    };
    deductCreditsMock.mockClear();

    callbacks.onSubagentCredits(4, { model: 'test-model', inputTokens: 2, outputTokens: 1 });
    await vi.waitFor(() =>
      expect(deductCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({ credits: 4, inputTokens: 2, outputTokens: 1 }),
        expect.anything()
      )
    );
  });

  it('awaits grandchild settlement before returning control to the next delegation', async () => {
    await dispatch();
    const callbacks = buildSharedToolsMock.mock.calls[0][1] as {
      onSubagentCredits(
        credits: number,
        meta: { model: string; inputTokens: number; outputTokens: number }
      ): Promise<void>;
    };
    const debit = Promise.withResolvers<void>();
    deductCreditsMock.mockImplementationOnce(() => debit.promise);
    const completed = vi.fn();
    const charge = callbacks.onSubagentCredits(4, { model: 'test-model', inputTokens: 2, outputTokens: 1 });
    const observe = async () => {
      await charge;
      completed();
    };
    const observed = observe();
    await vi.waitFor(() =>
      expect(deductCreditsMock).toHaveBeenCalledWith(expect.objectContaining({ credits: 4 }), expect.anything())
    );
    expect(completed).not.toHaveBeenCalled();
    debit.resolve();
    await observed;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each([false, true])('includes a stopped child charge in the parent total (user abort: %s)', async userAborted => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(agentExecutionRepository.checkAbortFlag).mockResolvedValueOnce(userAborted);
    delegateToAgentMock.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      return childResult;
    });
    try {
      const { handler } = await import('./agentExecutor');
      await handler(dagNodeDispatchEvent(), { getRemainingTimeInMillis: () => 1_000 } as Context);

      expect(deductCreditsMock).toHaveBeenCalledTimes(1);
      expect(agentExecutionRepository.incrementCreditsUsed).toHaveBeenCalledExactlyOnceWith('child-1', 7);
      const terminal = userAborted ? agentExecutionRepository.markAborted : agentExecutionRepository.markFailed;
      expect(terminal).toHaveBeenCalledTimes(1);
      const credited = vi.mocked(agentExecutionRepository.incrementCreditsUsed).mock.calls[0][1];
      expect(3 + credited).toBe(10);
      expect(vi.mocked(agentExecutionRepository.incrementCreditsUsed).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(terminal).mock.invocationCallOrder[0]
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('records grandchild spend before completing the dispatched child, without charging it twice', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    delegateToAgentMock.mockImplementation(async () => {
      const callbacks = buildSharedToolsMock.mock.calls[0][1] as {
        onSubagentCredits(credits: number, meta: { model: string; inputTokens: number; outputTokens: number }): void;
      };
      callbacks.onSubagentCredits(4, { model: 'test-model', inputTokens: 2, outputTokens: 1 });
      return childResult;
    });

    await dispatch();

    expect(deductCreditsMock).toHaveBeenCalledTimes(2);
    expect(agentExecutionRepository.incrementCreditsUsed).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentExecutionRepository.incrementCreditsUsed).mock.calls).toEqual([
      ['child-1', 4],
      ['child-1', 7],
    ]);
    const completedAt = vi.mocked(agentExecutionRepository.markComplete).mock.invocationCallOrder[0];
    for (const auditedAt of vi.mocked(agentExecutionRepository.incrementCreditsUsed).mock.invocationCallOrder) {
      expect(auditedAt).toBeLessThan(completedAt);
    }
  });

  it('does not recharge a completed or failed run when its audit write rejects', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    vi.mocked(agentExecutionRepository.incrementCreditsUsed).mockRejectedValueOnce(new Error('audit unavailable'));

    await dispatch();

    expect(deductCreditsMock).toHaveBeenCalledTimes(1);
    expect(agentExecutionRepository.markComplete).toHaveBeenCalledTimes(1);
    expect(agentExecutionRepository.markFailed).not.toHaveBeenCalled();

    vi.clearAllMocks();
    delegateToAgentMock.mockRejectedValue(Object.assign(new Error('provider failed'), { spent: childResult }));
    vi.mocked(agentExecutionRepository.incrementCreditsUsed).mockRejectedValueOnce(new Error('audit unavailable'));
    await dispatch();

    expect(deductCreditsMock).toHaveBeenCalledTimes(1);
    expect(agentExecutionRepository.markFailed).toHaveBeenCalledExactlyOnceWith('child-1', {
      message: 'provider failed',
      timedOut: false,
    });
  });

  it('refuses a subagent whose model the platform will not admit before it runs', async () => {
    admissionAssertMock.mockRejectedValueOnce(new Error('Model "test-model" has no price'));

    const { markFailed } = await dispatch();

    expect(admissionAssertMock).toHaveBeenCalledWith('test-model');
    expect(markFailed).toHaveBeenCalledWith('child-1', { message: 'Model "test-model" has no price' });
    expect(delegateToAgentMock).not.toHaveBeenCalled();
    expect(deductCreditsMock).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a subagent on a disabled model before it runs', async () => {
    const { getAvailableModels } = await import('@bike4mind/llm-adapters');
    vi.mocked(getAvailableModels).mockResolvedValue([{ ...testModel, disabled: true }] as never);

    const { markFailed } = await dispatch();

    expect(markFailed).toHaveBeenCalledWith('child-1', { message: 'Model "test-model" is not available to this user' });
    expect(delegateToAgentMock).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
  });

  it('reports a configuration read failure separately from model access and still terminates the DAG node', async () => {
    const { adminSettingsRepository } = await import('@bike4mind/database');
    vi.mocked(adminSettingsRepository.findOne).mockRejectedValueOnce(new Error('settings down'));

    const { markFailed } = await dispatch();

    expect(markFailed).toHaveBeenCalledWith('child-1', {
      message: 'Unable to load model configuration. Please retry.',
    });
    expect(delegateToAgentMock).not.toHaveBeenCalled();
    expect(deductCreditsMock).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a subagent on a model gated to an entitlement the user does not hold', async () => {
    const { adminSettingsRepository } = await import('@bike4mind/database');
    vi.mocked(adminSettingsRepository.findOne).mockResolvedValueOnce({
      settingValue: [{ id: 'test-model', enabled: true, allowedEntitlements: ['medlib:pro'] }],
    } as never);

    const { markFailed } = await dispatch();

    expect(markFailed).toHaveBeenCalledWith('child-1', { message: 'Model "test-model" is not available to this user' });
    expect(delegateToAgentMock).not.toHaveBeenCalled();
  });

  it('hands its own delegations only the models this user may run', async () => {
    const { getAvailableModels } = await import('@bike4mind/llm-adapters');
    vi.mocked(getAvailableModels).mockResolvedValue([
      testModel,
      { ...testModel, id: 'paused-model', disabled: true },
    ] as never);

    await dispatch();

    const deps = buildSharedToolsMock.mock.calls[0][0] as { subagentModels: Array<{ id: string }> };
    expect(deps.subagentModels.map(m => m.id)).toEqual(['test-model']);
  });

  it('refuses a subagent whose balance cannot cover its first iteration when credits are enforced', async () => {
    const { adminSettingsRepository, User } = await import('@bike4mind/database');
    vi.mocked(adminSettingsRepository.getSettingsValue).mockImplementation(
      (async (key: string) => key === 'enforceCredits') as never
    );
    vi.mocked(User.findById).mockResolvedValueOnce({ id: 'user-1', currentCredits: 1 } as never);

    const { markFailed } = await dispatch();
    vi.mocked(adminSettingsRepository.getSettingsValue).mockResolvedValue(false as never);

    expect(markFailed).toHaveBeenCalledWith('child-1', { message: 'Insufficient credits to run subagent' });
    expect(delegateToAgentMock).not.toHaveBeenCalled();
  });
  describe('usage events', () => {
    const usageRecord = async () => {
      const { usageEventRepository } = await import('@bike4mind/database');
      return vi.mocked(usageEventRepository.record);
    };

    it('records a usage event for a completed subagent, as the in-chat delegation path does', async () => {
      await dispatch();

      const record = await usageRecord();
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestId: 'quest-1',
          sessionId: 'session-1',
          userId: 'user-1',
          ownerId: 'user-1',
          feature: 'tool',
          provider: 'anthropic',
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 5,
          creditsCharged: 7,
          status: 'ok',
        })
      );
      expect(record.mock.calls[0][0].costUsd).toBeCloseTo(10 * 3e-6 + 5 * 15e-6, 12);
    });

    it('names the requested model on a restricted run and keeps the substitute as executedModel', async () => {
      const substitute = { ...testModel, id: 'cheap-model', backend: 'openai' };
      const { getAvailableModels } = await import('@bike4mind/llm-adapters');
      vi.mocked(getAvailableModels).mockResolvedValue([testModel, substitute] as never);
      shadowRoutingMock.mockResolvedValue({
        settings: { allowlist: ['cheap-model'], dailyTokenCap: 20000, requestsPerMin: 3 },
        modelInfo: substitute,
      });
      delegateToAgentMock.mockResolvedValue({ ...childResult, model: 'cheap-model' });

      await dispatch();

      expect(await usageRecord()).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'test-model',
          executedProvider: 'openai',
          executedModel: 'cheap-model',
        })
      );
    });

    it('leaves executedModel off an unrestricted run', async () => {
      await dispatch();

      const row = (await usageRecord()).mock.calls[0][0];
      expect(row.model).toBe('test-model');
      expect(row).not.toHaveProperty('executedModel');
    });

    it('records what a subagent spent before it failed', async () => {
      delegateToAgentMock.mockRejectedValue(Object.assign(new Error('provider 500'), { spent: childResult }));

      await dispatch();

      expect(await usageRecord()).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ feature: 'tool', creditsCharged: 7, inputTokens: 10, outputTokens: 5 })
      );
    });

    it('records an in-process grandchild from the priced usage it reports', async () => {
      delegateToAgentMock.mockImplementation(async () => {
        const callbacks = buildSharedToolsMock.mock.calls[0][1] as {
          onSubagentCredits(credits: number, meta: Record<string, unknown>): Promise<void>;
        };
        await callbacks.onSubagentCredits(4, {
          usdCost: 0.002,
          provider: 'anthropic',
          model: 'test-model',
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
        });
        return childResult;
      });

      await dispatch();

      const record = await usageRecord();
      expect(record).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ creditsCharged: 4, costUsd: 0.002, cachedInputTokens: 3, inputTokens: 2 })
      );
    });

    it('skips the event when the model cannot be priced, and still charges', async () => {
      delegateToAgentMock.mockResolvedValue({ ...childResult, model: 'unknown-model' });

      await dispatch();

      expect(await usageRecord()).not.toHaveBeenCalled();
      expect(deductCreditsMock).toHaveBeenCalledWith(expect.objectContaining({ credits: 7 }), expect.anything());
    });

    it('completes the subagent when the usage event write fails', async () => {
      (await usageRecord()).mockRejectedValueOnce(new Error('ledger unavailable'));
      const { agentExecutionRepository } = await import('@bike4mind/database');

      await dispatch();

      expect(deductCreditsMock).toHaveBeenCalledTimes(1);
      expect(agentExecutionRepository.markComplete).toHaveBeenCalledTimes(1);
      expect(agentExecutionRepository.markFailed).not.toHaveBeenCalled();
    });
  });
});
