import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// A loop run's tool failures through the real executor over Mongo, with only the edges stubbed: a tool the run
// does not have and a tool that throws are recorded by name on the execution, and only for loop runs.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({ deductCredits: vi.fn(), turn: 0 }));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : `mock-${String(key)}`) }),
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

vi.mock('@server/utils/loopDispatch', () => ({ requestLoopDispatch: vi.fn(), pushLoopChanged: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/persistRunAsQuest', () => ({
  persistRunAsQuest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/utils/publishMementoCompletion', () => ({
  resolveAndPublishMementoCompletion: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: vi.fn().mockReturnValue({}),
  getGeneratedImageStorage: vi.fn().mockReturnValue({}),
}));

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([
      {
        id: 'test-model',
        type: 'text',
        name: 'Test',
        backend: 'anthropic',
        contextWindow: 200_000,
        max_tokens: 4096,
        pricing: { 1_000_000: { input: 0.003, output: 0.015 } },
      },
    ]),
    getLlmByModel: () => ({
      currentModel: 'test-model',
      getModelInfo: async () => [],
      pushToolMessages: () => undefined,
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        // First turn: one call to a tool the run lacks and one to a tool that throws; then answer.
        const first = h.turn++ % 2 === 0;
        await callback([first ? 'Trying tools' : 'Done'], {
          inputTokens: 1000,
          outputTokens: 500,
          toolsUsed: first
            ? [
                { id: 'call-1', name: 'missing_tool', arguments: '{}' },
                { id: 'call-2', name: 'flaky_tool', arguments: '{}' },
              ]
            : [],
        });
      },
    }),
  };
});

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) },
    creditService: { ...actual.creditService, deductCreditsWithOrgSupport: h.deductCredits },
  };
});

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  const flaky = {
    toolFn: async () => {
      throw new Error('upstream down');
    },
    toolSchema: { name: 'flaky_tool', description: 'Fails', parameters: { type: 'object', properties: {} } },
  };
  return { ...actual, resolveToolAvailability: vi.fn().mockResolvedValue({}), buildSharedTools: () => [flaky] };
});

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

const lambdaContext = { getRemainingTimeInMillis: () => 600_000 } as never;

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // The seeded user has no paid plan and test-model is not on the free-tier allowlist.
  const { AdminSettings } = await import('@bike4mind/database');
  await AdminSettings.create({ settingName: 'freeTierModelGateEnabled', settingValue: 'false' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

async function runOnce(loopId?: string) {
  const { agentExecutionRepository, User, Session } = await import('@bike4mind/database');
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: userId,
    username: `tools-${userId}`,
    email: `${userId}@e2e.test`,
    currentCredits: 1e6,
  });
  await Session.collection.insertOne({ _id: sessionId, userId: userId.toString(), name: 'Tool failures' });
  const execution = await agentExecutionRepository.create({
    userId: userId.toString(),
    sessionId: sessionId.toString(),
    questId: sessionId.toString(),
    query: 'Use your tools',
    model: 'test-model',
    status: 'pending',
    connectionId: 'conn-1',
    ...(loopId && { loopId }),
    // Pre-approved, so the permission gate lets both calls through to the agent.
    approvedTools: ['missing_tool', 'flaky_tool'],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
  });

  h.turn = 0;
  const { handler } = await import('./agentExecutor');
  await handler(
    {
      executionId: execution.id,
      userId: userId.toString(),
      sessionId: sessionId.toString(),
      query: 'Use your tools',
      model: 'test-model',
      connectionId: 'conn-1',
    } as never,
    lambdaContext
  );
  return agentExecutionRepository.findById(execution.id);
}

describe('loop run tool failures, end to end', () => {
  it('records the unavailable and the throwing tool on a loop run', async () => {
    const run = await runOnce('loop-1');
    expect(run?.status).toBe('completed');
    expect(run?.toolsUnavailable).toEqual(['missing_tool']);
    expect(run?.toolsErrored).toEqual(['flaky_tool']);
  });

  it('records nothing on a run outside a loop', async () => {
    const run = await runOnce();
    expect(run?.status).toBe('completed');
    expect(run?.toolsUnavailable).toBeUndefined();
    expect(run?.toolsErrored).toBeUndefined();
  });
});
