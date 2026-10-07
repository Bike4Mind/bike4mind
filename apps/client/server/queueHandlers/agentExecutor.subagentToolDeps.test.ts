import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Drives the real `handler` through a `dag_node_dispatch` message and asserts what
// `processSubagentDispatch` hands `buildSharedTools`. Harness mirrors agentExecutor.subagentMediaBilling.test.ts.

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

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
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
  model: 'claude-sonnet-5',
  query: 'summarize the attached files',
  subagentConfig: { agentName: 'researcher', thoroughness: 'quick' },
};

const baseSession = { id: 'session-1', userId: 'user-1', disableUserIntegrations: true };

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(actual.agentExecutionRepository, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(actual.agentExecutionRepository, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markComplete').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'incrementCreditsUsed').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markAborted').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'checkAbortFlag').mockResolvedValue(false as never);
  vi.spyOn(actual.usageEventRepository, 'record').mockResolvedValue(undefined as never);
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue(baseSession as never);
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

const lambdaContext = { getRemainingTimeInMillis: () => 600_000 } as never;

async function dispatchWithSession(session: Record<string, unknown>) {
  const { sessionRepository } = await import('@bike4mind/database');
  vi.mocked(sessionRepository.findById).mockResolvedValue(session as never);
  const { handler } = await import('./agentExecutor');
  const result = await handler(dagNodeDispatchEvent(), lambdaContext);
  expect(result).toEqual({ batchItemFailures: [] });
  expect(buildSharedToolsMock).toHaveBeenCalledTimes(1);
  return buildSharedToolsMock.mock.calls[0][0] as Record<string, unknown>;
}

describe('processSubagentDispatch tool deps', () => {
  // The first import of agentExecutor dominates the run; paying it here keeps it off the per-test timeout.
  beforeAll(async () => {
    await import('./agentExecutor');
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    buildSharedToolsMock.mockReturnValue([]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the session's attached files as attachedFileIds alongside its library opt-out", async () => {
    const deps = await dispatchWithSession({
      ...baseSession,
      knowledgeIds: ['file-a', 'file-b'],
      includeLibraryFiles: false,
    });

    expect(deps.attachedFileIds).toEqual(['file-a', 'file-b']);
    expect(deps.sessionIncludeLibraryFiles).toBe(false);
  });

  it('passes an empty attachedFileIds when the session has no attached files', async () => {
    const deps = await dispatchWithSession(baseSession);

    expect(deps.attachedFileIds).toEqual([]);
  });
});

describe('attachedFileIdsForRun', () => {
  it('unions message files, session files and session knowledge without duplicates', async () => {
    const { attachedFileIdsForRun } = await import('./agentExecutor');
    expect(attachedFileIdsForRun({ messageFileIds: ['m', 'k'], sessionFabFileIds: ['f'] }, ['k']).sort()).toEqual([
      'f',
      'k',
      'm',
    ]);
  });

  it('falls back to session knowledge alone when the run carries no attachments', async () => {
    const { attachedFileIdsForRun } = await import('./agentExecutor');
    expect(attachedFileIdsForRun(undefined, ['k'])).toEqual(['k']);
    expect(attachedFileIdsForRun(undefined, undefined)).toEqual([]);
  });
});
