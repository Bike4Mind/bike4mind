import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'aws-lambda';

// `processSubagentDispatch`'s abort/deadline branch (the `abortController.signal.aborted`
// check inside the delegation try block) disambiguates a user/cascade abort from the
// Lambda-deadline watchdog via a second `checkAbortFlag` read, then fires
// `fireDagNodeTerminalOnRefusal` with the matching terminal status. Per
// `processSubagentDispatch`'s own KNOWN LIMITATION docstring, the deadline case is the
// realistic production failure mode for a `very_thorough` node, and neither shape had a
// regression test driving the real handler through it - the three existing
// `subagentCapGate` tests cover the same hook from other refusal paths (member-cap,
// session-ownership, outer-catch) that never reach this far.

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

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

const onDagNodeTerminalMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./agentExecutorDag', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutorDag')>('./agentExecutorDag');
  return { ...actual, onDagNodeTerminal: (...args: unknown[]) => onDagNodeTerminalMock(...args) };
});

// The models/backend resolution (`getAvailableModels` / `getLlmByModel`) is swapped for a
// fixed stub so the test doesn't depend on which real models/keys happen to be configured
// in this environment - only the abort disambiguation after `delegateToAgent` matters here.
vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model' }]),
    getLlmByModel: vi.fn().mockReturnValue({ currentModel: '' }),
  };
});

// Reaching `orchestrator.delegateToAgent` for real would mean standing up model
// resolution, MCP tool wiring, and a real `ServerSubagentOrchestrator` run - the exact
// scaffolding cost the issue calls out. Model resolution and `resolveToolAvailability` are
// stubbed below; `buildSharedTools` and `ServerAgentStore` run for real against an
// empty/disabled config so the seam under test - the abort disambiguation after
// `delegateToAgent` returns - is exercised on the real code path up to the orchestrator.
const delegateToAgentMock = vi.fn();
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  class MockOrchestrator {
    constructor(public deps: unknown) {}
    delegateToAgent(...args: unknown[]) {
      return delegateToAgentMock(...args);
    }
  }
  return {
    ...actual,
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    ServerSubagentOrchestrator: MockOrchestrator,
    // Real key lookup hits the DB (`apikeys.find()`), which has no connection in this test
    // and buffers until Mongoose's 10s timeout - short-circuit it to an empty table instead.
    // `apiKeyService` is an ES module namespace export (`export * as`), so it can't be
    // `vi.spyOn`'d in place - the whole binding is replaced instead.
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
  };
});

const childDoc = {
  id: 'child-1',
  status: 'pending',
  abortedAt: null,
  userId: 'user-1',
  sessionId: 'session-1',
  organizationId: null,
  parentExecutionId: 'parent-1',
  dagNodeId: 'node-b',
  model: 'test-model',
  subagentConfig: { agentName: 'researcher', thoroughness: 'quick' },
};

const mockMarkFailed = vi.fn().mockResolvedValue(undefined);
const mockMarkAborted = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(actual.agentExecutionRepository, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(actual.agentExecutionRepository, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockImplementation((...args) => mockMarkFailed(...args));
  vi.spyOn(actual.agentExecutionRepository, 'markAborted').mockImplementation((...args) => mockMarkAborted(...args));
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue({
    id: 'session-1',
    userId: 'user-1',
    disableUserIntegrations: true,
  } as never);
  vi.spyOn(actual.agentRepository, 'listForUser').mockResolvedValue([] as never);
  vi.spyOn(actual.agentExecutionRepository, 'checkAbortFlag').mockResolvedValue(false as never);
  // Gates the artifact-emission-prompt lookup right before orchestrator construction;
  // `false` skips the second (ArtifactEmissionPrompt) read entirely.
  vi.spyOn(actual.adminSettingsRepository, 'getSettingsValue').mockResolvedValue(false as never);
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

function makeSqsEvent(messages: Array<{ messageId: string; body: unknown }>) {
  return {
    Records: messages.map(m => ({ messageId: m.messageId, body: JSON.stringify(m.body) })),
  } as never;
}

function dagNodeDispatchEvent() {
  return makeSqsEvent([
    {
      messageId: 'msg-1',
      body: { kind: 'dag_node_dispatch', childExecutionId: 'child-1', connectionId: 'conn-1', dagNodeId: 'node-b' },
    },
  ]);
}

// Delegate resolves like the orchestrator's own timeout-handling path: partial results on
// an AbortError instead of a throw, after the abort poller has had a chance to tick at
// least once. Fake timers make the race between the poll interval and this resolution
// deterministic instead of a real 5s wait.
function delegateResolvesAfterOnePoll(pollMs: number) {
  return new Promise(resolve => {
    setTimeout(
      () =>
        resolve({
          finalAnswer: 'partial answer',
          steps: [{ role: 'assistant', content: 'partial step' }],
          completionInfo: { totalCredits: 3, totalTokens: 100, iterations: 2, reachedMaxIterations: false },
        }),
      pollMs * 2
    );
  });
}

describe('agentExecutor: processSubagentDispatch abort/deadline disambiguation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDagNodeTerminalMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the child failed (isTimeout) when the Lambda deadline watchdog trips, not the abort flag', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    vi.mocked(agentExecutionRepository.checkAbortFlag).mockResolvedValue(false);

    const { handler, SUBAGENT_ABORT_POLL_MS } = await import('./agentExecutor');
    delegateToAgentMock.mockImplementation(() => delegateResolvesAfterOnePoll(SUBAGENT_ABORT_POLL_MS));
    const context = { getRemainingTimeInMillis: () => 5_000 } as unknown as Context;

    const resultPromise = handler(dagNodeDispatchEvent(), context);
    await vi.advanceTimersByTimeAsync(SUBAGENT_ABORT_POLL_MS * 3);
    await resultPromise;

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

  it('marks the child aborted (not failed) when the abort flag is set, even though the signal also fired', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    vi.mocked(agentExecutionRepository.checkAbortFlag).mockResolvedValue(true);

    const { handler, SUBAGENT_ABORT_POLL_MS } = await import('./agentExecutor');
    delegateToAgentMock.mockImplementation(() => delegateResolvesAfterOnePoll(SUBAGENT_ABORT_POLL_MS));
    // Plenty of remaining time - the deadline watchdog must NOT be what trips the signal here.
    const context = { getRemainingTimeInMillis: () => 300_000 } as unknown as Context;

    const resultPromise = handler(dagNodeDispatchEvent(), context);
    await vi.advanceTimersByTimeAsync(SUBAGENT_ABORT_POLL_MS * 3);
    await resultPromise;

    expect(mockMarkAborted).toHaveBeenCalledWith('child-1', {
      steps: [{ role: 'assistant', content: 'partial step' }],
      partialAnswer: 'partial answer',
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
