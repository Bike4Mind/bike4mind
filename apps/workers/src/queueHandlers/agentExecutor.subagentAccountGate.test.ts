import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';

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

// Each iteration emits a step through the handler's tracker, then "calls the provider". The handler's
// per-iteration account check runs inside onStep, so a block that lands mid-run must stop the loop
// before the next provider call.
const ITERATIONS = 3;
const providerCalls = { count: 0 };
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
  subagentConfig: { agentName: 'researcher', thoroughness: 'very_thorough' },
};

// The per-iteration re-read; the dispatch-time User.findById stays an active account.
const mockFreshUserRead = vi.fn();
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
  vi.spyOn(actual.userRepository, 'findById').mockImplementation((...args) => mockFreshUserRead(...args));
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

describe('processSubagentDispatch per-iteration account check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerCalls.count = 0;
    mockCheckAbortFlag.mockResolvedValue(false);
  });

  it('stops a subagent whose account is suspended mid-run before its next provider call', async () => {
    const suspended = { id: 'user-1', isBanned: true };
    mockFreshUserRead.mockResolvedValue(suspended);
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), ctx);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(providerCalls.count).toBe(1);
    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: aiAccessDeniedMessage(suspended) });
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(mockMarkAborted).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ child: expect.objectContaining({ id: 'child-1', status: 'failed' }) })
    );
  });

  it('runs every iteration to completion for an active account, checking once per iteration', async () => {
    mockFreshUserRead.mockResolvedValue({ id: 'user-1', currentCredits: 100 });
    const { handler } = await import('./agentExecutor');

    await handler(dagNodeDispatchEvent(), ctx);

    expect(providerCalls.count).toBe(ITERATIONS);
    expect(mockFreshUserRead).toHaveBeenCalledTimes(ITERATIONS);
    expect(mockMarkComplete).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});
