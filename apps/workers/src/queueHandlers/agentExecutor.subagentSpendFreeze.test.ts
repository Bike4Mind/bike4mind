import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spendFrozenError, type ISpendFreeze } from '@bike4mind/common';

// Model admission reads admin settings from the real repository; these tests exercise other gates.
vi.mock('@bike4mind/server-utils/utils/thinkingVisibility', () => ({
  resolveThinkingVisibility: vi.fn(async () => 'raw'),
}));
vi.mock('@bike4mind/server-utils/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({ admits: async () => true, assert: async () => {} }),
}));

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

const onDagNodeTerminalMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./agentExecutorDag', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutorDag')>('./agentExecutorDag');
  return { ...actual, onDagNodeTerminal: (...args: unknown[]) => onDagNodeTerminalMock(...args) };
});

// Local tool builders: neutralised so the dispatch reaches the orchestrator without building a
// real tool pool - what happens inside them is not what this branch is about.
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

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn().mockReturnValue({}),
  getGeneratedImageStorage: vi.fn().mockReturnValue({}),
}));

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([]),
    // Truthy, mutable (the handler assigns `llm.currentModel`) so the `!llm` guard passes.
    getLlmByModel: vi.fn().mockReturnValue({ currentModel: undefined }),
  };
});

// Each iteration "calls the provider", then emits a step through the handler's tracker. The handler's
// per-iteration account check runs inside onStep. This mock awaits onStep; the real orchestrator does not,
// so in production the abort lands on the next call already in flight.
const ITERATIONS = 3;
const providerCalls = { count: 0 };
const orchestrator = { throwsAfterRun: false };
const runResult = {
  steps: [{ content: 'partial work' }],
  finalAnswer: 'partial answer',
  completionInfo: { totalCredits: 0, totalTokens: 0, iterations: 1, reachedMaxIterations: false },
};
type StepTracker = { onStep: (arg: { step: { content: string }; iteration: number }) => Promise<void> };
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
  };
});
vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    buildSharedTools: vi.fn().mockReturnValue([]),
    ServerAgentStore: class {
      getAgent() {
        return { name: 'researcher', allowedTools: [], deniedTools: [] };
      }
    },
    ServerSubagentOrchestrator: class {
      private signal?: AbortSignal;
      private tracker: StepTracker;
      constructor(opts: { signal?: AbortSignal; tracker: StepTracker }) {
        this.signal = opts.signal;
        this.tracker = opts.tracker;
      }
      async delegateToAgent() {
        for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
          if (this.signal?.aborted) break;
          providerCalls.count++;
          await this.tracker.onStep({ step: { content: `step ${iteration}` }, iteration });
        }
        if (orchestrator.throwsAfterRun) throw new Error('provider failed after abort');
        return runResult;
      }
    },
  };
});

const childDoc = {
  id: 'child-1',
  status: 'pending',
  abortedAt: null,
  userId: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  parentExecutionId: 'parent-1',
  dagNodeId: 'node-b',
  model: 'claude-sonnet-5',
  query: 'summarize the corpus',
  apiKeyId: 'key-1',
  subagentConfig: { agentName: 'researcher', thoroughness: 'very_thorough' },
};

// The account stays active throughout; only the spend freeze varies.
const mockFindActiveFreeze = vi.fn();
const mockMarkFailed = vi.fn().mockResolvedValue(undefined);
const mockMarkComplete = vi.fn().mockResolvedValue(undefined);
const mockMarkAborted = vi.fn().mockResolvedValue(undefined);
const mockCheckAbortFlag = vi.fn().mockResolvedValue(false);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(actual.agentExecutionRepository, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(actual.agentExecutionRepository, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markComplete').mockImplementation((...args) => mockMarkComplete(...args));
  vi.spyOn(actual.agentExecutionRepository, 'incrementCreditsUsed').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockImplementation((...args) => mockMarkFailed(...args));
  vi.spyOn(actual.agentExecutionRepository, 'markAborted').mockImplementation((...args) => mockMarkAborted(...args));
  vi.spyOn(actual.agentExecutionRepository, 'checkAbortFlag').mockImplementation((...args) =>
    mockCheckAbortFlag(...args)
  );
  vi.spyOn(actual.userRepository, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.spendFreezeRepository, 'findActiveForSubject').mockImplementation((...args) =>
    mockFindActiveFreeze(...args)
  );
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  // disableUserIntegrations short-circuits loadMcpToolsForSession to an empty pool - no MCP wiring.
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue({
    id: 'session-1',
    userId: 'user-1',
    disableUserIntegrations: true,
  } as never);
  // Null org: skips the org-pool and per-member cap gates so the flow reaches the orchestrator.
  vi.spyOn(actual.organizationRepository, 'findById').mockResolvedValue(null as never);
  vi.spyOn(actual.agentRepository, 'listForUser').mockResolvedValue([] as never);
  vi.spyOn(actual.agentRepository, 'listForOrganization').mockResolvedValue([] as never);
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

// Ample remaining time keeps the deadline watchdog dormant.
const ctx = { getRemainingTimeInMillis: () => 600_000 } as never;

const frozenKey = {
  scopeType: 'apiKey',
  scopeId: 'key-1',
  frozenAt: new Date(),
  reason: 'test freeze',
} as unknown as ISpendFreeze;
const frozenMessage = spendFrozenError(frozenKey).message;

describe('processSubagentDispatch spend freeze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerCalls.count = 0;
    orchestrator.throwsAfterRun = false;
    mockCheckAbortFlag.mockResolvedValue(false);
    mockFindActiveFreeze.mockResolvedValue(null);
  });

  it('refuses a subagent whose API key was frozen before dispatch, with no provider call', async () => {
    mockFindActiveFreeze.mockResolvedValue(frozenKey);
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), ctx);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(providerCalls.count).toBe(0);
    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: frozenMessage });
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ child: expect.objectContaining({ id: 'child-1', status: 'failed' }) })
    );
  });

  it('stops a subagent frozen mid-run before its next provider call', async () => {
    mockFindActiveFreeze.mockResolvedValueOnce(null).mockResolvedValue(frozenKey);
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), ctx);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(providerCalls.count).toBe(1);
    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: frozenMessage });
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(mockMarkAborted).not.toHaveBeenCalled();
  });

  it('records the freeze when the orchestrator throws after a mid-run freeze', async () => {
    mockFindActiveFreeze.mockResolvedValueOnce(null).mockResolvedValue(frozenKey);
    orchestrator.throwsAfterRun = true;
    const { handler } = await import('./agentExecutor');

    await handler(dagNodeDispatchEvent(), ctx);

    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: frozenMessage, timedOut: false });
    expect(mockMarkAborted).not.toHaveBeenCalled();
  });

  it('checks the run user, the billed organization and the key', async () => {
    const { handler } = await import('./agentExecutor');

    await handler(dagNodeDispatchEvent(), ctx);

    expect(mockFindActiveFreeze).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1', apiKeyId: 'key-1' });
    expect(providerCalls.count).toBe(ITERATIONS);
    expect(mockMarkComplete).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});
