import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The abort/deadline branch in `processSubagentDispatch` (the `abortController.signal.aborted`
// check AFTER `orchestrator.delegateToAgent` returns) is the one terminal exit the sibling
// `agentExecutor.subagentCapGate.test.ts` does not cover: those tests all short-circuit at a
// refusal gate BEFORE the orchestrator ever runs. This drives the real `handler` all the way to
// the orchestrator, then trips the deadline watchdog so the branch fires, and asserts it still
// reaches `fireDagNodeTerminalOnRefusal` (via the mocked `onDagNodeTerminal`) - the "very_thorough
// node hits the Lambda deadline" production failure mode called out in the hook's own docstring.
// Without that hook a timed-out child leaves the parent wedged in `awaiting_dag_children`, which
// `cleanupStaleActive` deliberately never sweeps.

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

vi.mock('@server/utils/storage', () => ({
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

// The orchestrator receives the handler's `AbortController.signal`. We can't reach the controller
// to abort it directly, so `delegateToAgent` resolves ONLY once the signal aborts - and the real
// deadline watchdog (driven by fake timers below) is what trips it. That keeps the watchdog under
// test rather than stubbed, and returns the partial-result shape the abort branch reads.
const partialResult = {
  steps: [{ content: 'partial work' }],
  finalAnswer: 'partial answer',
  completionInfo: { totalCredits: 0, totalTokens: 0, iterations: 1, reachedMaxIterations: false },
};
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    // Namespace re-export can't be spied in ESM, so replace it wholesale (keeping its other members).
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    buildSharedTools: vi.fn().mockReturnValue([]),
    ServerAgentStore: class {
      getAgent() {
        return { name: 'researcher', allowedTools: [], deniedTools: [] };
      }
    },
    ServerSubagentOrchestrator: class {
      private signal?: AbortSignal;
      constructor(opts: { signal?: AbortSignal }) {
        this.signal = opts.signal;
      }
      delegateToAgent() {
        if (this.signal?.aborted) return Promise.resolve(partialResult);
        return new Promise(resolve => {
          this.signal?.addEventListener('abort', () => resolve(partialResult));
        });
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

const mockMarkFailed = vi.fn().mockResolvedValue(undefined);
const mockMarkAborted = vi.fn().mockResolvedValue(undefined);
// Default false = deadline (timeout) branch. A test flips it to true for the user-abort branch.
const mockCheckAbortFlag = vi.fn().mockResolvedValue(false);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(actual.agentExecutionRepository, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(actual.agentExecutionRepository, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markComplete').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'incrementCreditsUsed').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockImplementation((...args) => mockMarkFailed(...args));
  vi.spyOn(actual.agentExecutionRepository, 'markAborted').mockImplementation((...args) => mockMarkAborted(...args));
  vi.spyOn(actual.agentExecutionRepository, 'checkAbortFlag').mockImplementation((...args) =>
    mockCheckAbortFlag(...args)
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

// getRemainingTimeInMillis under the 90s PARENT_DEADLINE_BUFFER_MS makes the first poll tick trip
// the deadline; over it keeps the deadline dormant so the abort-flag path can be exercised instead.
function ctx(remainingMs: number) {
  return { getRemainingTimeInMillis: () => remainingMs } as never;
}

describe('processSubagentDispatch abort/deadline branch fires onDagNodeTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAbortFlag.mockResolvedValue(false);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the hook and marks the child timed-out when the Lambda deadline trips mid-run', async () => {
    const { handler } = await import('./agentExecutor');

    // Remaining time below the 90s buffer -> the 5s poll tick trips the deadline watchdog.
    const pending = handler(dagNodeDispatchEvent(), ctx(1_000));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toEqual({ batchItemFailures: [] });
    // Deadline (not user) abort: marked failed with timedOut, never markAborted.
    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', {
      message: 'Subagent stopped before Lambda deadline (partial result preserved in result.steps)',
      timedOut: true,
    });
    expect(mockMarkAborted).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        child: expect.objectContaining({ id: 'child-1', dagNodeId: 'node-b', status: 'failed' }),
      })
    );
  });

  it('marks the child aborted (not timed-out) when the user abort flag trips instead', async () => {
    mockCheckAbortFlag.mockResolvedValue(true);
    const { handler } = await import('./agentExecutor');

    // Ample remaining time so the deadline stays dormant; the abort flag is what fires.
    const pending = handler(dagNodeDispatchEvent(), ctx(600_000));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toEqual({ batchItemFailures: [] });
    // User abort: partial result preserved via markAborted, never the timedOut markFailed.
    expect(mockMarkAborted).toHaveBeenCalledWith('child-1', {
      steps: partialResult.steps,
      partialAnswer: partialResult.finalAnswer,
    });
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        child: expect.objectContaining({ id: 'child-1', dagNodeId: 'node-b', status: 'aborted' }),
      })
    );
  });
});
