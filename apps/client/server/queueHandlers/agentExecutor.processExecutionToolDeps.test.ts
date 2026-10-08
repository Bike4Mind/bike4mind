import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

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
  vi.spyOn(actual.usageEventRepository, 'record').mockResolvedValue(undefined as never);
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue(baseSession as never);
  vi.spyOn(actual.organizationRepository, 'findById').mockResolvedValue(null as never);
  vi.spyOn(actual.agentRepository, 'listForUser').mockResolvedValue([] as never);
  vi.spyOn(actual.agentRepository, 'listForOrganization').mockResolvedValue([] as never);
  vi.spyOn(actual.adminSettingsRepository, 'getSettingsValue').mockResolvedValue(false as never);
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

  it('resolves an unset library flag to included for a session with no explicit lake scope', async () => {
    const deps = await runWithSession(baseSession);

    expect(deps.sessionIncludeLibraryFiles).toBe(true);
  });

  it('resolves a stored false to included when Data Lakes is off', async () => {
    const deps = await runWithSession({ ...baseSession, includeLibraryFiles: false, forceKnowledgeRetrieval: false });

    expect(deps.sessionIncludeLibraryFiles).toBe(true);
  });
});
