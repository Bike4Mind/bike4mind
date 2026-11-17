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

// One key-started run over a real Mongo, with only the edges stubbed: the per-iteration text charge
// must name the key that started the run so per-key spend rollups see it.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({ deductCredits: vi.fn(), complete: vi.fn(), getLlmByModel: vi.fn() }));

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
    getAvailableModels: vi.fn().mockResolvedValue([
      {
        id: 'test-model',
        type: 'text',
        name: 'Test',
        backend: 'anthropic',
        contextWindow: 200_000,
        pricing: { 1_000_000: { input: 0.003, output: 0.015 } },
      },
      {
        id: 'cheap-denied',
        type: 'text',
        name: 'Denied cheap',
        backend: 'gemini',
        contextWindow: 200_000,
        pricing: { 1_000_000: { input: 0.001, output: 0.002 } },
      },
      {
        id: 'cheap-allowed',
        type: 'text',
        name: 'Allowed cheap',
        backend: 'anthropic',
        contextWindow: 200_000,
        pricing: { 1_000_000: { input: 0.001, output: 0.002 } },
      },
    ]),
    getLlmByModel: h.getLlmByModel,
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

vi.mock('./agentExecutorDag', async importOriginal => ({
  ...(await importOriginal<typeof import('./agentExecutorDag')>()),
  onDagNodeTerminal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./agentExecutor.latticeTools', async importOriginal => ({
  ...(await importOriginal<typeof import('./agentExecutor.latticeTools')>()),
  buildSubagentLatticeToolPool: vi.fn().mockReturnValue([]),
}));

beforeEach(() => {
  h.complete
    .mockReset()
    .mockImplementation(
      async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        await callback(['Done'], { inputTokens: 1000, outputTokens: 500, toolsUsed: [] });
      }
    );
  h.getLlmByModel.mockReset().mockImplementation(() => ({
    currentModel: '',
    getModelInfo: async () => [],
    pushToolMessages: () => undefined,
    complete: h.complete,
  }));
  h.deductCredits.mockReset().mockResolvedValue(undefined);
});

const lambdaContext = { getRemainingTimeInMillis: () => 600_000 } as never;

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // The seeded user has no paid plan and test-model is not on the free-tier allowlist.
  const { AdminSettings } = await import('@bike4mind/database');
  await AdminSettings.create({ settingName: 'freeTierModelGateEnabled', settingValue: 'false' });
  await AdminSettings.create([
    { settingName: 'shadowTierModelAllowlist', settingValue: '["cheap-denied","cheap-allowed"]' },
    { settingName: 'shadowTierDailyTokenCap', settingValue: '20000' },
    { settingName: 'shadowTierRequestsPerMin', settingValue: '3' },
  ]);
  const { invalidateSettingsCache } = await import('@bike4mind/utils');
  invalidateSettingsCache();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

async function seedShadowRun(kind: 'main' | 'child', modelPolicy: unknown) {
  const { agentExecutionRepository, User, Session, Organization } = await import('@bike4mind/database');
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: userId,
    username: `shadow-${userId}`,
    email: `${userId}@e2e.test`,
    currentCredits: 1e6,
    isAdmin: false,
    tags: [],
    throttle: { tier: 'shadow' },
  });
  const organization = await Organization.create({
    name: 'Shadow policy',
    userId: userId.toHexString(),
    personal: false,
    currentCredits: 1e6,
    users: [{ userId: userId.toHexString(), permissions: ['read'] }],
    modelPolicy,
  });
  await Session.collection.insertOne({
    _id: sessionId,
    userId: userId.toHexString(),
    name: 'Shadow run',
    disableUserIntegrations: true,
  });
  const base = {
    userId: userId.toHexString(),
    sessionId: sessionId.toHexString(),
    questId: sessionId.toHexString(),
    organizationId: organization.id,
    query: 'Say done',
    model: 'test-model',
    connectionId: 'conn-shadow',
    approvedTools: [],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
  };
  const parent = await agentExecutionRepository.create({ ...base, status: kind === 'main' ? 'pending' : 'running' });
  const execution =
    kind === 'main'
      ? parent
      : await agentExecutionRepository.create({
          ...base,
          status: 'pending',
          parentExecutionId: parent.id,
          dagNodeId: 'policy-node',
          subagentConfig: { agentName: 'researcher', thoroughness: 'quick', maxIterations: 3 },
        });
  return { execution, organization, userId: userId.toHexString(), sessionId: sessionId.toHexString() };
}

async function dispatchShadowRun(kind: 'main' | 'child', run: Awaited<ReturnType<typeof seedShadowRun>>) {
  const { handler } = await import('./agentExecutor');
  if (kind === 'main') {
    await handler(
      {
        executionId: run.execution.id,
        userId: run.userId,
        sessionId: run.sessionId,
        query: 'Say done',
        model: 'test-model',
        connectionId: 'conn-shadow',
      } as never,
      lambdaContext
    );
  } else {
    await handler(
      {
        Records: [
          {
            messageId: 'policy-node',
            body: JSON.stringify({
              kind: 'dag_node_dispatch',
              childExecutionId: run.execution.id,
              connectionId: 'conn-shadow',
              dagNodeId: 'policy-node',
            }),
          },
        ],
      } as never,
      lambdaContext
    );
  }
}

describe('agent run billing, end to end', () => {
  it.each([
    ['main', 'provider'],
    ['main', 'model'],
    ['child', 'provider'],
    ['child', 'model'],
  ] as const)(
    'runs the allowed shadow backend through real %s execution under a %s restriction',
    async (kind, restriction) => {
      const run = await seedShadowRun(
        kind,
        restriction === 'provider'
          ? { allowedProviders: ['anthropic'] }
          : { allowedModels: ['test-model', 'cheap-allowed'] }
      );
      await dispatchShadowRun(kind, run);
      const { agentExecutionRepository } = await import('@bike4mind/database');
      const completedExecution = await agentExecutionRepository.findById(run.execution.id);
      expect(completedExecution?.status, JSON.stringify(completedExecution?.error)).toBe('completed');
      expect(h.complete.mock.calls.length).toBeGreaterThan(0);
      expect(h.complete.mock.calls.every(call => call[0] === 'cheap-allowed')).toBe(true);
      expect(h.getLlmByModel.mock.calls.some(call => call[1].modelInfo.id === 'cheap-allowed')).toBe(true);
      expect(h.getLlmByModel.mock.calls.some(call => call[1].modelInfo.id === 'cheap-denied')).toBe(false);
      expect(h.deductCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          organization: expect.objectContaining({ id: run.organization.id }),
        }),
        expect.anything()
      );
    }
  );

  it.each(['main', 'child'] as const)(
    'keeps the requested model when %s has no allowed cheap candidate',
    async kind => {
      const run = await seedShadowRun(kind, { allowedModels: ['test-model'] });
      await dispatchShadowRun(kind, run);
      const { agentExecutionRepository } = await import('@bike4mind/database');
      const completedExecution = await agentExecutionRepository.findById(run.execution.id);
      expect(completedExecution?.status, JSON.stringify(completedExecution?.error)).toBe('completed');
      expect(h.complete.mock.calls.length).toBeGreaterThan(0);
      expect(h.complete.mock.calls.every(call => call[0] === 'test-model')).toBe(true);
    }
  );

  it.each(['main', 'child'] as const)(
    'refuses invalid organization policy before %s invokes a provider',
    async kind => {
      const run = await seedShadowRun(kind, { allowedProviders: [] });
      await dispatchShadowRun(kind, run);
      const { agentExecutionRepository } = await import('@bike4mind/database');
      const refusedExecution = await agentExecutionRepository.findById(run.execution.id);
      expect(refusedExecution?.status).toBe('failed');
      expect(refusedExecution?.error?.message).toContain('not allowed by your organization');
      expect(h.complete).not.toHaveBeenCalled();
    }
  );

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
