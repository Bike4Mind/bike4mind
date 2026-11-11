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
import { LOW_CONFIDENCE_STREAK_TO_PAUSE } from './agentExecutorUtils/confidenceGate';
import { LOW_CONFIDENCE_REOPEN_NUDGE } from '@bike4mind/server-utils/utils/reopenLowConfidenceAnswer';

// Confidence gate pause -> resume -> complete over a real Mongo, with only the edges stubbed.
// `confidenceOverrides` scripts one low entry per probe turn so the streak fires the gate.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const PROBE_TOOL = 'probe_tool';
const FINAL_ANSWER = 'Probe finished';

const h = vi.hoisted(() => ({
  wsEvents: [] as Array<{ action: string; [key: string]: unknown }>,
  dispatched: [] as Array<Record<string, unknown>>,
  llmTurns: 0,
  // Transcript the model saw on its most recent turn.
  lastMessages: [] as IMessage[],
  // Turns that call the probe before the model answers; set by the test.
  probeTurns: 1,
  // Profile `lowConfidenceCompletion` the executor resolves; undefined keeps the executor default.
  lowConfidenceMode: undefined as 'block' | 'annotate' | 'off' | undefined,
  // Profile `confidenceGateThreshold` the executor resolves; undefined keeps the built-in threshold.
  gateThreshold: undefined as number | undefined,
  // Makes the API Gateway send reject for the `completed` frame only.
  failCompletedSend: false,
  // Profile `confidenceGateMode` / `confidenceGateSelfReport`; undefined keeps the built-in default.
  gateMode: undefined as 'iteration' | 'answer' | 'both' | 'off' | undefined,
  selfReport: undefined as boolean | undefined,
}));

vi.mock('./agentExecutor.orchestrationProfile', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutor.orchestrationProfile')>(
    './agentExecutor.orchestrationProfile'
  );
  return {
    ...actual,
    resolveTopLevelProfile: async (args: Parameters<typeof actual.resolveTopLevelProfile>[0]) => ({
      ...(await actual.resolveTopLevelProfile(args)),
      lowConfidenceCompletion: h.lowConfidenceMode,
      confidenceGateThreshold: h.gateThreshold,
      confidenceGateMode: h.gateMode,
      confidenceGateSelfReport: h.selfReport,
    }),
  };
});

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : `mock-${String(key)}`) }),
  }),
}));

// Both handlers stream over API Gateway; capture every frame either one sends.
vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send(command: { input: { Data: Buffer } }) {
      const event = JSON.parse(command.input.Data.toString());
      if (h.failCompletedSend && event.action === 'completed') return Promise.reject(new Error('gone'));
      h.wsEvents.push(event);
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
        h.lastMessages = structuredClone(_messages);
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
    buildSharedTools: (
      _deps: unknown,
      callbacks: {
        onStatusUpdate: (changes: Record<string, unknown>) => Promise<void>;
        onUiSideEffect: (effect: { type: string; payload: unknown }) => Promise<void>;
      }
    ) => [
      {
        toolFn: async () => {
          await callbacks.onStatusUpdate({
            images: ['probe-image.png'],
            promptMeta: { retrieval: { attempted: true, outcome: 'hit', surfaces: [], dataLakeTags: [] } },
          });
          await callbacks.onUiSideEffect({ type: 'probe_effect', payload: { ok: true } });
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
    username: `gate-e2e-${userId}`,
    email: `gate-${userId}@e2e.test`,
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
  beforeEach(() => {
    h.wsEvents.length = 0;
    h.dispatched.length = 0;
    h.llmTurns = 0;
    h.probeTurns = 1;
    h.lowConfidenceMode = undefined;
    h.gateThreshold = undefined;
    h.failCompletedSend = false;
    h.gateMode = undefined;
    h.selfReport = undefined;
  });

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

  describe('a final answer after one low iteration', () => {
    async function runToAnswer(confidence: number, maxIterations?: number, turns = 1) {
      const { handler } = await import('./agentExecutor');
      h.probeTurns = turns;
      const run = await seedRun(Array(turns).fill(confidence));
      await handler(
        {
          executionId: run.executionId,
          userId: run.userId,
          sessionId: run.sessionId,
          query: 'Run the probe, then report',
          model: 'test-model',
          connectionId: 'conn-1',
          ...(maxIterations !== undefined && { maxIterations }),
        } as never,
        lambdaContext
      );
      const { agentExecutionRepository } = await import('@bike4mind/database');
      return { ...run, execution: await agentExecutionRepository.findById(run.executionId) };
    }
    const actions = () => h.wsEvents.map(event => event.action);

    it('annotate (the default) keeps the answer, emits low_confidence_completion, and completes', async () => {
      const { executionId, execution } = await runToAnswer(0.1);

      expect(execution?.status).toBe('completed');
      expect(execution?.result).toMatchObject({ answer: FINAL_ANSWER });
      expect(h.wsEvents).toContainEqual(
        expect.objectContaining({ action: 'low_confidence_completion', executionId, confidence: 0.1, mode: 'annotate' })
      );
      expect(execution?.result).toMatchObject({ lowConfidence: { confidence: 0.1 } });
      expect(actions()).not.toContain('confidence_gate');
      expect(actions().indexOf('low_confidence_completion')).toBeLessThan(actions().indexOf('completed'));
    });

    const respond = async (executionId: string, userId: string, decision: 'stop' | 'continue') => {
      const { handleGateResponse } = await import('@server/websocket/agentExecute');
      await handleGateResponse(
        { accessToken: 'unused', action: 'agent_execute', command: 'gate_response', executionId, decision },
        userId,
        'conn-1',
        'https://ws.test/stage',
        logger as never
      );
    };
    const finalAnswerSteps = (execution: { checkpoint?: unknown } | null | undefined) =>
      ((execution?.checkpoint as { steps: Array<{ type: string }> } | undefined)?.steps ?? []).filter(
        step => step.type === 'final_answer'
      );

    it('block pauses the run with the finished result held back, and Stop finalizes it in full', async () => {
      h.lowConfidenceMode = 'block';
      const { persistRunAsQuest } = await import('@server/utils/persistRunAsQuest');
      vi.mocked(persistRunAsQuest).mockClear();
      const { executionId, userId, execution } = await runToAnswer(0.1);

      expect(execution?.status).toBe('paused');
      expect(execution?.pendingGate).toMatchObject({ confidence: 0.1 });
      expect(execution?.pendingCompletion).toMatchObject({
        answer: FINAL_ANSWER,
        replyText: FINAL_ANSWER,
        lowConfidence: { confidence: 0.1 },
      });
      // A completion pause keeps the streak so a reconsidered answer with no better evidence is re-flagged.
      expect(execution?.lowConfidenceStreak).toBe(1);
      // The score was scripted, so the pause stays out of the fire-rate counters like any scripted gate.
      expect(execution?.confidenceTelemetry).toMatchObject({ evaluatedCount: 0, emittedCount: 0 });
      expect(actions()).toEqual(expect.arrayContaining(['low_confidence_completion', 'confidence_gate']));
      expect(actions()).not.toContain('completed');
      expect(persistRunAsQuest).not.toHaveBeenCalled();

      await respond(executionId, userId, 'stop');

      const { agentExecutionRepository } = await import('@bike4mind/database');
      const stopped = await agentExecutionRepository.findById(executionId);
      expect(stopped?.status).toBe('completed');
      expect(stopped?.pendingCompletion).toBeUndefined();
      // Same result shape as a normal low-confidence completion: accepted, not stopped mid-run.
      expect(stopped?.result).toMatchObject({ answer: FINAL_ANSWER, lowConfidence: { confidence: 0.1 } });
      expect(stopped?.result).not.toHaveProperty('stoppedByGate');
      expect(h.wsEvents).toContainEqual(
        expect.objectContaining({ action: 'completed', executionId, answer: FINAL_ANSWER })
      );
      expect(persistRunAsQuest).toHaveBeenCalledWith(
        executionId,
        FINAL_ANSWER,
        expect.anything(),
        ['probe-image.png'],
        'end_turn',
        [{ type: 'probe_effect', payload: { ok: true } }],
        { attempted: true, outcome: 'hit', surfaces: [], dataLakeTags: [] }
      );
    });

    it('Stop and Continue racing on a held completion produce exactly one outcome', async () => {
      h.lowConfidenceMode = 'block';
      const { persistRunAsQuest } = await import('@server/utils/persistRunAsQuest');
      vi.mocked(persistRunAsQuest).mockClear();
      const { executionId, userId } = await runToAnswer(0.1);

      await Promise.all([respond(executionId, userId, 'stop'), respond(executionId, userId, 'continue')]);

      const { agentExecutionRepository } = await import('@bike4mind/database');
      const settled = await agentExecutionRepository.findById(executionId);
      const completedFrames = h.wsEvents.filter(event => event.action === 'completed');
      if (settled?.status === 'completed') {
        expect(persistRunAsQuest).toHaveBeenCalledTimes(1);
        expect(completedFrames).toHaveLength(1);
        expect(h.dispatched).toEqual([]);
      } else {
        expect(settled?.status).toBe('continuing');
        expect(h.dispatched).toHaveLength(1);
        expect(persistRunAsQuest).not.toHaveBeenCalled();
        expect(completedFrames).toHaveLength(0);
      }
    });

    it('a double Continue dispatches the executor once', async () => {
      h.lowConfidenceMode = 'block';
      const { executionId, userId } = await runToAnswer(0.1);

      await Promise.all([respond(executionId, userId, 'continue'), respond(executionId, userId, 'continue')]);

      expect(h.dispatched).toEqual([{ executionId, connectionId: 'conn-1' }]);
    });

    it('Stop still writes the Quest and completes when the completed event cannot be delivered', async () => {
      h.lowConfidenceMode = 'block';
      const { persistRunAsQuest } = await import('@server/utils/persistRunAsQuest');
      vi.mocked(persistRunAsQuest).mockClear();
      const { executionId, userId } = await runToAnswer(0.1);

      h.failCompletedSend = true;
      try {
        await respond(executionId, userId, 'stop');
      } finally {
        h.failCompletedSend = false;
      }

      const { agentExecutionRepository } = await import('@bike4mind/database');
      const stopped = await agentExecutionRepository.findById(executionId);
      expect(stopped?.status).toBe('completed');
      expect(persistRunAsQuest).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[Gate] Completed event not delivered',
        expect.objectContaining({ executionId })
      );
    });

    it('Continue reopens the answer with a verify nudge and ends with one final answer', async () => {
      // Admin default rather than the profile: a continuation does not re-resolve the profile.
      const { AdminSettings } = await import('@bike4mind/database');
      await AdminSettings.create({
        settingName: 'orchestrationDefaults',
        settingValue: { lowConfidenceCompletion: 'block' } as never,
      });
      try {
        await continueThenStop();
      } finally {
        await AdminSettings.collection.deleteOne({ settingName: 'orchestrationDefaults' });
      }
    });

    async function continueThenStop() {
      const { executionId, userId, execution } = await runToAnswer(0.1);
      expect(execution?.status).toBe('paused');

      await respond(executionId, userId, 'continue');

      const { agentExecutionRepository } = await import('@bike4mind/database');
      const reopened = await agentExecutionRepository.findById(executionId);
      expect(reopened?.status).toBe('continuing');
      expect(reopened?.pendingGate).toBeUndefined();
      expect(reopened?.pendingCompletion).toBeUndefined();
      expect(finalAnswerSteps(reopened)).toHaveLength(0);
      expect((reopened?.checkpoint as { steps: Array<{ type: string; content: string }> }).steps.slice(-2)).toEqual([
        expect.objectContaining({ type: 'thought', content: FINAL_ANSWER }),
        expect.objectContaining({ type: 'observation', content: LOW_CONFIDENCE_REOPEN_NUDGE }),
      ]);

      await (await import('./agentExecutor')).handler(h.dispatched[0] as never, lambdaContext);

      expect(h.lastMessages.slice(-2)).toEqual([
        expect.objectContaining({ role: 'assistant', content: FINAL_ANSWER }),
        expect.objectContaining({ role: 'user', content: LOW_CONFIDENCE_REOPEN_NUDGE }),
      ]);
      // The new answer gathered no new evidence, so it is flagged and held again.
      const repaused = await agentExecutionRepository.findById(executionId);
      expect(repaused?.status).toBe('paused');
      expect(finalAnswerSteps(repaused)).toHaveLength(1);

      await respond(executionId, userId, 'stop');
      const completed = await agentExecutionRepository.findById(executionId);
      expect(completed?.status).toBe('completed');
      expect(completed?.result).toMatchObject({ answer: FINAL_ANSWER });
      expect(
        (completed?.result as { steps: Array<{ type: string }> }).steps.filter(s => s.type === 'final_answer')
      ).toHaveLength(1);
    }

    it('Continue accepts the held answer when no iteration is left to reconsider in', async () => {
      h.lowConfidenceMode = 'block';
      const { executionId, userId, execution } = await runToAnswer(0.1, 2);
      expect(execution?.status).toBe('paused');

      await respond(executionId, userId, 'continue');

      const { agentExecutionRepository } = await import('@bike4mind/database');
      const completed = await agentExecutionRepository.findById(executionId);
      expect(h.dispatched).toEqual([]);
      expect(completed?.status).toBe('completed');
      expect(completed?.result).toMatchObject({ answer: FINAL_ANSWER, lowConfidence: { confidence: 0.1 } });
      expect(finalAnswerSteps({ checkpoint: completed?.result })).toHaveLength(1);
    });

    it('a repeated Stop finalizes the held answer once', async () => {
      h.lowConfidenceMode = 'block';
      const { persistRunAsQuest } = await import('@server/utils/persistRunAsQuest');
      vi.mocked(persistRunAsQuest).mockClear();
      const { executionId, userId } = await runToAnswer(0.1);

      await Promise.all([respond(executionId, userId, 'stop'), respond(executionId, userId, 'stop')]);

      expect(persistRunAsQuest).toHaveBeenCalledTimes(1);
      expect(actions().filter(action => action === 'completed')).toHaveLength(1);
    });

    it('takes the mode from admin orchestration defaults when the profile sets none', async () => {
      const { AdminSettings } = await import('@bike4mind/database');
      await AdminSettings.create({
        settingName: 'orchestrationDefaults',
        settingValue: { lowConfidenceCompletion: 'block' } as never,
      });
      try {
        const { execution } = await runToAnswer(0.1);

        expect(execution?.status).toBe('paused');
        expect(actions()).toContain('low_confidence_completion');
      } finally {
        await AdminSettings.collection.deleteOne({ settingName: 'orchestrationDefaults' });
      }
    });

    it('off completes with no low_confidence_completion event', async () => {
      h.lowConfidenceMode = 'off';
      const { execution } = await runToAnswer(0.1);

      expect(execution?.status).toBe('completed');
      expect(execution?.result).toMatchObject({ answer: FINAL_ANSWER });
      expect(execution?.result).not.toHaveProperty('lowConfidence');
      expect(actions()).not.toContain('low_confidence_completion');
    });

    it('emits nothing when the iteration before the answer cleared the threshold', async () => {
      const { execution } = await runToAnswer(0.9);

      expect(execution?.status).toBe('completed');
      expect(execution?.result).not.toHaveProperty('lowConfidence');
      expect(actions()).not.toContain('low_confidence_completion');
    });

    it('a profile mode beats the admin default', async () => {
      h.lowConfidenceMode = 'off';
      const { AdminSettings } = await import('@bike4mind/database');
      await AdminSettings.create({
        settingName: 'orchestrationDefaults',
        settingValue: { lowConfidenceCompletion: 'block' } as never,
      });
      try {
        const { execution } = await runToAnswer(0.1);

        expect(execution?.status).toBe('completed');
        expect(actions()).not.toContain('low_confidence_completion');
      } finally {
        await AdminSettings.collection.deleteOne({ settingName: 'orchestrationDefaults' });
      }
    });

    it('uses the profile threshold when it sets one', async () => {
      h.gateThreshold = 0.05;
      const { execution } = await runToAnswer(0.1);

      expect(execution?.status).toBe('completed');
      expect(actions()).not.toContain('low_confidence_completion');
    });

    describe('gate mode and self-report', () => {
      // A streak long enough to pause the iteration site, then a final answer.
      const streakTurns = LOW_CONFIDENCE_STREAK_TO_PAUSE;

      it('iteration pauses on the streak and skips the answer-site check after the resume', async () => {
        h.gateMode = 'iteration';
        const { agentExecutionRepository } = await import('@bike4mind/database');
        const { handler } = await import('./agentExecutor');
        const { handleGateResponse } = await import('@server/websocket/agentExecute');
        const run = await runToAnswer(0.1, undefined, streakTurns + 1);
        const { executionId, userId } = run;

        expect(run.execution?.status).toBe('paused');
        expect(run.execution?.confidenceGate).toMatchObject({ mode: 'iteration', selfReport: true });
        expect(actions()).toContain('confidence_gate');

        await handleGateResponse(
          {
            accessToken: 'unused',
            action: 'agent_execute',
            command: 'gate_response',
            executionId,
            decision: 'continue',
          },
          userId,
          'conn-1',
          'https://ws.test/stage',
          logger as never
        );
        await handler(h.dispatched[0] as never, lambdaContext);

        const completed = await agentExecutionRepository.findById(executionId);
        expect(completed?.status).toBe('completed');
        expect(actions()).not.toContain('low_confidence_completion');
      });

      it('answer never pauses an iteration but still flags the low-confidence answer', async () => {
        h.gateMode = 'answer';
        const { execution } = await runToAnswer(0.1, undefined, streakTurns);

        expect(execution?.status).toBe('completed');
        expect(actions()).not.toContain('confidence_gate');
        expect(actions()).toContain('low_confidence_completion');
        expect(execution?.lowConfidenceStreak).toBeGreaterThan(0);
      });

      it('answer in block mode parks the run on the low-confidence answer', async () => {
        h.gateMode = 'answer';
        h.lowConfidenceMode = 'block';
        const { execution } = await runToAnswer(0.1, undefined, streakTurns);

        expect(execution?.status).toBe('paused');
        expect(actions()).toContain('low_confidence_completion');
      });

      it('off emits no gate events', async () => {
        h.gateMode = 'off';
        const { execution } = await runToAnswer(0.1, undefined, streakTurns);

        expect(execution?.status).toBe('completed');
        expect(actions()).not.toContain('confidence_gate');
        expect(actions()).not.toContain('low_confidence_completion');
      });

      it('self-report off records no streak and emits no gate events', async () => {
        h.selfReport = false;
        const { execution } = await runToAnswer(0.1, undefined, streakTurns);

        expect(execution?.status).toBe('completed');
        expect(actions()).not.toContain('confidence_gate');
        expect(actions()).not.toContain('low_confidence_completion');
        expect(execution?.lowConfidenceStreak ?? 0).toBe(0);
      });

      it('a threshold of 0 never pauses', async () => {
        h.gateThreshold = 0;
        const { execution } = await runToAnswer(0.1, undefined, streakTurns);

        expect(execution?.status).toBe('completed');
        expect(actions()).not.toContain('confidence_gate');
      });
    });

    it('emits nothing when the answer lands on the iteration ceiling', async () => {
      const { execution } = await runToAnswer(0.1, 1);

      expect(execution?.status).toBe('completed');
      expect(execution?.result).toMatchObject({ reachedMaxIterations: true });
      expect(actions()).not.toContain('low_confidence_completion');
    });
  });
});
