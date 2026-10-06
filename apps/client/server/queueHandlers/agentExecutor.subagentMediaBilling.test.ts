import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageModels } from '@bike4mind/common';

// Generated media a dispatched subagent produces is paid upstream whether or not the run
// finishes, so `processSubagentDispatch` folds it from the tool callbacks and settles it once
// in the `finally` around `delegateToAgent`. These tests drive the real `handler` to the
// orchestrator, fire tool callbacks from a stubbed `delegateToAgent`, and assert the wallet
// deduction + audit counter. The estimator (`estimateGeneratedMediaUsd`) is real.

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

const IMAGE_MODEL_ID = ImageModels.GROK_IMAGINE_IMAGE_QUALITY;

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([{ id: ImageModels.GROK_IMAGINE_IMAGE_QUALITY }]),
    getLlmByModel: vi.fn().mockReturnValue({ currentModel: undefined }),
  };
});

// 1 credit per 0.001 USD, rounded up: Grok Imagine's flat 0.055 USD/image becomes exactly 55.
vi.mock('@bike4mind/utils', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/utils')>('@bike4mind/utils');
  return { ...actual, usdToCreditsStochastic: (usd: number) => Math.ceil(usd * 1000) };
});

const deductCreditsWithOrgSupportMock = vi.fn();
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
    creditService: {
      ...actual.creditService,
      deductCreditsWithOrgSupport: (...args: unknown[]) => deductCreditsWithOrgSupportMock(...args),
    },
  };
});

type ToolCallbacks = {
  onToolStart: (toolName: string, data: unknown) => Promise<void>;
  onToolFinish: (toolName: string, data: unknown) => Promise<void>;
};
type DelegateBehavior = (callbacks: ToolCallbacks) => Promise<unknown>;

let capturedCallbacks: ToolCallbacks | undefined;
let delegateBehavior: DelegateBehavior = async () => completedResult;

const completedResult = {
  steps: [{ content: 'work' }],
  finalAnswer: 'done',
  completionInfo: { totalCredits: 0, totalTokens: 0, iterations: 1, reachedMaxIterations: false },
};

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    buildSharedTools: vi.fn().mockImplementation((_deps: unknown, callbacks: ToolCallbacks) => {
      capturedCallbacks = callbacks;
      return [];
    }),
    ServerAgentStore: class {
      getAgent() {
        return { name: 'researcher', allowedTools: [], deniedTools: [] };
      }
    },
    ServerSubagentOrchestrator: class {
      delegateToAgent() {
        if (!capturedCallbacks) throw new Error('buildSharedTools was not called before delegateToAgent');
        return delegateBehavior(capturedCallbacks);
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
  query: 'summarize the corpus',
  subagentConfig: { agentName: 'researcher', thoroughness: 'very_thorough' },
};

const mockMarkFailed = vi.fn().mockResolvedValue(undefined);
const mockMarkComplete = vi.fn().mockResolvedValue(undefined);
const mockIncrementCreditsUsed = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(actual.agentExecutionRepository, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(actual.agentExecutionRepository, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markComplete').mockImplementation((...args) => mockMarkComplete(...args));
  vi.spyOn(actual.agentExecutionRepository, 'incrementCreditsUsed').mockImplementation((...args) =>
    mockIncrementCreditsUsed(...args)
  );
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockImplementation((...args) => mockMarkFailed(...args));
  vi.spyOn(actual.agentExecutionRepository, 'markAborted').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'checkAbortFlag').mockResolvedValue(false as never);
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue({
    id: 'session-1',
    userId: 'user-1',
    disableUserIntegrations: true,
  } as never);
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
const imagePayload = { model: IMAGE_MODEL_ID, n: 1, prompt: 'a bicycle' };
const EXPECTED_IMAGE_CREDITS = 55;

describe('processSubagentDispatch generated-media billing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCallbacks = undefined;
    delegateBehavior = async () => completedResult;
    deductCreditsWithOrgSupportMock.mockResolvedValue(undefined);
    const llmAdapters = await import('@bike4mind/llm-adapters');
    vi.mocked(llmAdapters.getAvailableModels).mockResolvedValue([{ id: IMAGE_MODEL_ID }] as never);
  });

  it('deducts the generated-image credits from the wallet and mirrors them onto the child audit counter', async () => {
    delegateBehavior = async callbacks => {
      await callbacks.onToolStart('image_generation', imagePayload);
      return completedResult;
    };
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), lambdaContext);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(deductCreditsWithOrgSupportMock).toHaveBeenCalledTimes(1);
    expect(deductCreditsWithOrgSupportMock.mock.calls[0][0]).toMatchObject({
      type: 'text_generation_usage',
      credits: EXPECTED_IMAGE_CREDITS,
      sessionId: 'session-1',
      questId: 'quest-1',
      model: 'claude-sonnet-5',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(mockIncrementCreditsUsed).toHaveBeenCalledWith('child-1', EXPECTED_IMAGE_CREDITS);
    // Settled before the terminal write, so a parent woken by the DAG hook rolls up the media too.
    expect(mockIncrementCreditsUsed.mock.invocationCallOrder[0]).toBeLessThan(
      mockMarkComplete.mock.invocationCallOrder[0]
    );
  });

  it('still deducts media generated before the run rejects, and marks the child failed', async () => {
    delegateBehavior = async callbacks => {
      await callbacks.onToolStart('image_generation', imagePayload);
      throw new Error('agent blew up');
    };
    const { handler } = await import('./agentExecutor');

    await handler(dagNodeDispatchEvent(), lambdaContext);

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed.mock.calls[0][0]).toBe('child-1');
    expect(deductCreditsWithOrgSupportMock).toHaveBeenCalledTimes(1);
    expect(deductCreditsWithOrgSupportMock.mock.calls[0][0]).toMatchObject({ credits: EXPECTED_IMAGE_CREDITS });
    expect(mockIncrementCreditsUsed).toHaveBeenCalledWith('child-1', EXPECTED_IMAGE_CREDITS);
  });

  it('does not deduct anything when only a non-media tool fires', async () => {
    delegateBehavior = async callbacks => {
      await callbacks.onToolStart('web_search', { query: 'bicycles' });
      await callbacks.onToolFinish('web_search', { query: 'bicycles' });
      return completedResult;
    };
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), lambdaContext);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockMarkComplete).toHaveBeenCalledTimes(1);
    expect(deductCreditsWithOrgSupportMock).not.toHaveBeenCalled();
    expect(mockIncrementCreditsUsed).not.toHaveBeenCalled();
  });

  it('keeps the terminal status when the media deduction itself fails', async () => {
    deductCreditsWithOrgSupportMock.mockRejectedValue(new Error('wallet unavailable'));
    delegateBehavior = async callbacks => {
      await callbacks.onToolStart('image_generation', imagePayload);
      return completedResult;
    };
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), lambdaContext);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(deductCreditsWithOrgSupportMock).toHaveBeenCalledTimes(1);
    expect(mockMarkComplete).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});
