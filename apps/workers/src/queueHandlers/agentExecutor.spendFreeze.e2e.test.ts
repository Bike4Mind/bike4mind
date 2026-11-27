import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
vi.mock('@bike4mind/server-utils/utils/thinkingVisibility', () => ({
  resolveThinkingVisibility: vi.fn(async () => 'raw'),
}));
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { spendFrozenError, type ISpendFreeze, type SpendFreezeSubject } from '@bike4mind/common';

// A spend freeze stopping an agent run, driven through the SQS handler over a real Mongo with only the edges
// stubbed. The probe tool is where a freeze lands mid-run, so the next iteration must not reach the model.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const PROBE_TOOL = 'probe_tool';
const FINAL_ANSWER = 'Probe finished';
const FROZEN_SCOPE = {
  scopeType: 'User',
  scopeId: 'user',
  frozenAt: new Date(),
  reason: 'test freeze',
} as unknown as ISpendFreeze;

const h = vi.hoisted(() => ({
  wsEvents: [] as Array<{ action: string; [key: string]: unknown }>,
  llmTurns: 0,
  // Turns that call the probe before the model answers.
  probeTurns: 1,
  // The user id a freeze applies to, or null for none. Read live on every freeze lookup.
  frozenUserId: null as string | null,
  // Set by the probe tool: freezes the run's own user once iteration 1's tool call has run.
  freezeOnProbe: false,
  currentUserId: '',
  freezeReads: [] as SpendFreezeSubject[],
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : `mock-${String(key)}`) }),
  }),
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send(command: { input: { Data: Buffer } }) {
      h.wsEvents.push(JSON.parse(command.input.Data.toString()));
      return Promise.resolve({});
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@bike4mind/server-utils/utils/persistRunAsQuest', () => ({
  persistRunAsQuest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/server-utils/utils/publishMementoCompletion', () => ({
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
    getAvailableModels: vi.fn().mockResolvedValue([]),
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
        const turn = h.llmTurns++;
        const probeTurn = turn < h.probeTurns;
        await callback([probeTurn ? 'Calling the probe' : FINAL_ANSWER], {
          inputTokens: 10,
          outputTokens: 5,
          stopReason: probeTurn ? 'tool_use' : 'end_turn',
          toolsUsed: probeTurn ? [{ id: `call-${turn + 1}`, name: PROBE_TOOL, arguments: '{}' }] : [],
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
    creditService: { ...actual.creditService, deductCreditsWithOrgSupport: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    resolveToolAvailability: vi.fn().mockResolvedValue({}),
    buildSharedTools: () => [
      {
        toolFn: async () => {
          if (h.freezeOnProbe) h.frozenUserId = h.currentUserId;
          return 'probe ok';
        },
        toolSchema: {
          name: PROBE_TOOL,
          description: 'A tool that always succeeds',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ],
  };
});

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.spendFreezeRepository, 'findActiveForSubject').mockImplementation(async subject => {
    h.freezeReads.push(subject);
    return h.frozenUserId !== null && subject.userId === h.frozenUserId ? FROZEN_SCOPE : null;
  });
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

async function seedRun(status: 'pending' | 'continuing') {
  const { agentExecutionRepository, User, Session } = await import('@bike4mind/database');
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: userId,
    username: `freeze-e2e-${userId}`,
    email: `freeze-${userId}@e2e.test`,
    currentCredits: 10_000,
  });
  await Session.collection.insertOne({ _id: sessionId, userId: userId.toString(), name: 'Freeze e2e' });
  const execution = await agentExecutionRepository.create({
    userId: userId.toString(),
    sessionId: sessionId.toString(),
    questId: sessionId.toString(),
    query: 'Run the probe, then report',
    model: 'test-model',
    status,
    connectionId: 'conn-1',
    approvedTools: [PROBE_TOOL],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
  });
  h.currentUserId = userId.toString();
  return { executionId: execution.id, userId: userId.toString(), sessionId: sessionId.toString() };
}

// The direct start invoke `startAgentExecution` sends: runs the loop from iteration 0, no checkpoint needed.
const startEvent = (run: { executionId: string; userId: string; sessionId: string }) =>
  ({ ...run, query: 'Run the probe, then report', model: 'test-model', connectionId: 'conn-1' }) as never;

// A continuation message off the queue; resolving with no batchItemFailures is the ack.
const sqsEvent = (executionId: string) =>
  ({
    Records: [{ messageId: 'msg-1', body: JSON.stringify({ executionId, connectionId: 'conn-1' }) }],
  }) as never;

describe('agent run spend freeze, through the handler', () => {
  beforeEach(() => {
    h.wsEvents.length = 0;
    h.llmTurns = 0;
    h.probeTurns = 1;
    h.frozenUserId = null;
    h.freezeOnProbe = false;
    h.freezeReads.length = 0;
  });

  it('refuses a run frozen at start: failed with spend_frozen, no model call, message acked', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    const { handler } = await import('./agentExecutor');
    const { executionId, userId } = await seedRun('continuing');
    h.frozenUserId = userId;

    await expect(handler(sqsEvent(executionId), lambdaContext)).resolves.toEqual({ batchItemFailures: [] });

    const run = await agentExecutionRepository.findById(executionId);
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe(spendFrozenError(FROZEN_SCOPE).message);
    expect(h.llmTurns).toBe(0);
    expect(h.wsEvents).toContainEqual(expect.objectContaining({ action: 'failed', reason: 'spend_frozen' }));
  });

  it('stops a run frozen between iterations 1 and 2 before the second model call, message acked', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    const { handler } = await import('./agentExecutor');
    const seeded = await seedRun('pending');
    const { executionId } = seeded;
    h.freezeOnProbe = true;

    await expect(handler(startEvent(seeded), lambdaContext)).resolves.toBeUndefined();

    const run = await agentExecutionRepository.findById(executionId);
    expect(h.llmTurns).toBe(1);
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe(spendFrozenError(FROZEN_SCOPE).message);
    expect(h.wsEvents).toContainEqual(expect.objectContaining({ action: 'failed', reason: 'spend_frozen' }));
    expect(h.wsEvents).not.toContainEqual(expect.objectContaining({ action: 'completed' }));
  });

  it('runs to completion when only an unrelated scope is frozen', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    const { handler } = await import('./agentExecutor');
    const seeded = await seedRun('pending');
    const { executionId, userId } = seeded;
    h.frozenUserId = `not-${userId}`;

    await expect(handler(startEvent(seeded), lambdaContext)).resolves.toBeUndefined();

    expect((await agentExecutionRepository.findById(executionId))?.status).toBe('completed');
    expect(h.llmTurns).toBe(2);
    expect(h.freezeReads.length).toBeGreaterThanOrEqual(3);
  });
});
