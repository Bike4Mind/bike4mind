import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '@bike4mind/common';
import type { CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { LOW_CONFIDENCE_STREAK_TO_PAUSE } from './agentExecutorUtils/confidenceGate';

// Confidence gate pause -> resume -> complete over a real Mongo, with only the edges stubbed.
// `confidenceOverrides` scripts one low entry per probe turn so the streak fires the gate.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const PROBE_TOOL = 'probe_tool';
const FINAL_ANSWER = 'Probe finished';

const h = vi.hoisted(() => ({
  wsEvents: [] as Array<{ action: string; [key: string]: unknown }>,
  dispatched: [] as Array<Record<string, unknown>>,
  llmTurns: 0,
  // Turns that call the probe before the model answers; set by the test.
  probeTurns: 1,
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : `mock-${String(key)}`) }),
  }),
}));

// Both handlers stream over API Gateway; capture every frame either one sends.
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

// The gate_response handler re-invokes the executor through here; the test plays the queue.
vi.mock('@server/utils/dispatchAgentExecution', () => ({
  AgentExecutorRejectedError: class extends Error {},
  resolveAgentExecutorTarget: () => ({ kind: 'lambda', functionName: 'agent-executor' }),
  dispatchAgentExecution: async (payload: Record<string, unknown>) => {
    h.dispatched.push(payload);
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
        toolFn: async () => 'probe ok',
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
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

const lambdaContext = { getRemainingTimeInMillis: () => 600_000 } as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

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

async function seedRun(confidenceOverrides: number[]) {
  const { agentExecutionRepository, User, Session } = await import('@bike4mind/database');
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: userId,
    username: 'gate-e2e',
    email: 'gate@e2e.test',
    currentCredits: 10_000,
  });
  await Session.collection.insertOne({ _id: sessionId, userId: userId.toString(), name: 'Gate e2e' });

  const execution = await agentExecutionRepository.create({
    userId: userId.toString(),
    sessionId: sessionId.toString(),
    questId: sessionId.toString(),
    query: 'Run the probe, then report',
    model: 'test-model',
    status: 'pending',
    connectionId: 'conn-1',
    // Pre-approved so the permission gate never withholds the call: the run must reach the
    // confidence gate, which is evaluated after the permission gate.
    approvedTools: [PROBE_TOOL],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
    confidenceOverrides,
  });
  return { executionId: execution.id, userId: userId.toString(), sessionId: sessionId.toString() };
}

describe('confidence gate, end to end', () => {
  it('pauses on a streak of low overrides, resumes through a gate response, and completes', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    const { handler } = await import('./agentExecutor');
    const { handleGateResponse } = await import('@server/websocket/agentExecute');
    h.probeTurns = LOW_CONFIDENCE_STREAK_TO_PAUSE;
    const { executionId, userId, sessionId } = await seedRun(Array(LOW_CONFIDENCE_STREAK_TO_PAUSE).fill(0.1));

    // Invocation 1, the direct start invoke `startAgentExecution` sends: each probe turn scores
    // well, but the script says 0.1, so the gate pauses once the streak is long enough.
    await handler(
      {
        executionId,
        userId,
        sessionId,
        query: 'Run the probe, then report',
        model: 'test-model',
        connectionId: 'conn-1',
      } as never,
      lambdaContext
    );

    const paused = await agentExecutionRepository.findById(executionId);
    expect(paused?.status).toBe('paused');
    // 0-indexed wire iteration of the turn that completed the streak.
    expect(paused?.pendingGate).toMatchObject({ iteration: LOW_CONFIDENCE_STREAK_TO_PAUSE - 1, confidence: 0.1 });
    expect(h.llmTurns).toBe(LOW_CONFIDENCE_STREAK_TO_PAUSE);
    expect(h.wsEvents).toContainEqual(
      expect.objectContaining({ action: 'confidence_gate', executionId, confidence: 0.1 })
    );
    // A scripted score must not skew the gate's real fire-rate telemetry.
    expect(paused?.confidenceTelemetry).toMatchObject({ evaluatedCount: 0, emittedCount: 0 });

    // The user answers the card: the real WS handler clears the gate and re-dispatches.
    await handleGateResponse(
      { accessToken: 'unused', action: 'agent_execute', command: 'gate_response', executionId, decision: 'continue' },
      userId,
      'conn-1',
      'https://ws.test/stage',
      logger as never
    );
    const resumed = await agentExecutionRepository.findById(executionId);
    expect(resumed?.status).toBe('continuing');
    expect(resumed?.pendingGate).toBeUndefined();
    expect(h.dispatched).toEqual([{ executionId, connectionId: 'conn-1' }]);

    // Invocation 2: the continuation picks up the checkpoint and the model answers. Its final
    // turn uses no tools, so the gate has nothing to score and the run completes.
    await handler(h.dispatched[0] as never, lambdaContext);

    const completed = await agentExecutionRepository.findById(executionId);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toMatchObject({ answer: FINAL_ANSWER });
    expect(h.llmTurns).toBe(LOW_CONFIDENCE_STREAK_TO_PAUSE + 1);
    expect(h.wsEvents).toContainEqual(expect.objectContaining({ action: 'completed', executionId }));
  });
});
