import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// A loop run's recorded cost (totalCreditsUsed) must equal the user's balance change for that run.
// The real executor, persistRunAsQuest, memento publisher and credit deduction run over Mongo. The
// session name/summary/tag and memento jobs that would bill outside the run are EventBridge handlers
// that run asynchronously, so "no billable event published" is the in-process proxy for "no off-run
// debit"; the event bus publish calls are spied for that.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  autoName: vi.fn().mockResolvedValue(undefined),
  summarize: vi.fn().mockResolvedValue(undefined),
  completionCompleted: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock('@server/utils/eventBus', async () => {
  const actual = await vi.importActual<typeof import('@server/utils/eventBus')>('@server/utils/eventBus');
  return {
    ...actual,
    SessionEvents: {
      ...actual.SessionEvents,
      AutoName: { ...actual.SessionEvents.AutoName, publish: h.autoName },
      Summarize: { ...actual.SessionEvents.Summarize, publish: h.summarize },
    },
    LLMEvents: {
      ...actual.LLMEvents,
      CompletionCompleted: { ...actual.LLMEvents.CompletionCompleted, publish: h.completionCompleted },
    },
  };
});
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
  // Mementos on (with each run opting in), so only the loop guard can skip the memento publish.
  await AdminSettings.create({ settingName: 'EnableMementos', settingValue: true });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

async function run(loopId?: string) {
  const { agentExecutionRepository, User, Session, Quest } = await import('@bike4mind/database');
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: userId,
    username: `spend-${userId}`,
    email: `${userId}@e2e.test`,
    currentCredits: 1e6,
  });
  await Session.collection.insertOne({ _id: sessionId, userId: userId.toString(), name: 'Loop notebook' });
  const execution = await agentExecutionRepository.create({
    userId: userId.toString(),
    sessionId: sessionId.toString(),
    questId: sessionId.toString(),
    query: 'Say done',
    model: 'test-model',
    status: 'pending',
    connectionId: 'conn-1',
    ...(loopId ? { loopId } : {}),
    enableMementos: true,
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
  const user = await User.findById(userId).lean();
  const quest = await Quest.findOne({ sessionId: sessionId.toString() }).lean();
  return {
    run: await agentExecutionRepository.findById(execution.id),
    balanceDrop: 1e6 - user!.currentCredits!,
    quest,
  };
}

describe('loop run spend, end to end', () => {
  it("debits exactly the run's recorded cost and publishes no billable post-run job", async () => {
    h.autoName.mockClear();
    h.summarize.mockClear();
    h.completionCompleted.mockClear();
    const { run: loopRun, balanceDrop, quest } = await run('loop-1');

    expect(loopRun?.status).toBe('completed');
    expect(quest).toBeTruthy();
    expect(loopRun!.totalCreditsUsed).toBeGreaterThan(0);
    expect(balanceDrop).toBeCloseTo(loopRun!.totalCreditsUsed!, 6);
    expect(h.autoName).not.toHaveBeenCalled();
    expect(h.summarize).not.toHaveBeenCalled();
    expect(h.completionCompleted).not.toHaveBeenCalled();
  });

  it('still names, summarizes and mines mementos for a non-loop run', async () => {
    h.autoName.mockClear();
    h.summarize.mockClear();
    h.completionCompleted.mockClear();
    const { run: plainRun } = await run();

    expect(plainRun?.status).toBe('completed');
    expect(h.autoName).toHaveBeenCalled();
    expect(h.summarize).toHaveBeenCalled();
    expect(h.completionCompleted).toHaveBeenCalled();
  });
});
