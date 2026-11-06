import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// One key-started run over a real Mongo, with only the edges stubbed: the per-iteration text charge
// must name the key that started the run so per-key spend rollups see it.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({ deductCredits: vi.fn() }));

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

vi.mock('@server/utils/persistRunAsQuest', () => ({ persistRunAsQuest: vi.fn().mockResolvedValue(undefined) }));
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
        await callback(['Done'], { inputTokens: 1000, outputTokens: 500, toolsUsed: [] });
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
  return { ...actual, resolveToolAvailability: vi.fn().mockResolvedValue({}), buildSharedTools: () => [] };
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

describe('agent run billing, end to end', () => {
  it("stamps the run's API key on its iteration text charge", async () => {
    const { agentExecutionRepository, User, Session } = await import('@bike4mind/database');
    const userId = new mongoose.Types.ObjectId();
    const sessionId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: userId, username: 'key-run', email: 'key@e2e.test', currentCredits: 1e6 });
    await Session.collection.insertOne({ _id: sessionId, userId: userId.toString(), name: 'Key run' });
    const execution = await agentExecutionRepository.create({
      userId: userId.toString(),
      sessionId: sessionId.toString(),
      questId: sessionId.toString(),
      query: 'Say done',
      model: 'test-model',
      status: 'pending',
      connectionId: 'conn-1',
      apiKeyId: 'key-run-1',
      approvedTools: [],
      deniedTools: [],
      iterationBilling: [],
      totalCreditsUsed: 0,
      lambdaInvocationCount: 1,
      childExecutionIds: [],
    });

    const { handler } = await import('./agentExecutor');
    await handler(
      {
        executionId: execution.id,
        userId: userId.toString(),
        sessionId: sessionId.toString(),
        query: 'Say done',
        model: 'test-model',
        connectionId: 'conn-1',
      } as never,
      lambdaContext
    );

    expect((await agentExecutionRepository.findById(execution.id))?.status).toBe('completed');
    expect(h.deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text_generation_usage', model: 'test-model', apiKeyId: 'key-run-1' }),
      expect.anything()
    );
  });
});
