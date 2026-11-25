import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindById = vi.fn();
const mockClearPendingGate = vi.fn();
const mockRestoreRejectedResume = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentExecutionRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    markComplete: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    restoreRejectedResume: (...args: unknown[]) => mockRestoreRejectedResume(...args),
    clearPendingGate: (...args: unknown[]) => mockClearPendingGate(...args),
  },
}));

vi.mock('../utils/liveActivityPush', () => ({ endAgentRunLiveActivity: vi.fn() }));
vi.mock('../utils/persistRunAsQuest', () => ({
  persistRunAsQuest: vi.fn(),
}));
vi.mock('../briefs/eventBriefTrigger', () => ({
  startEventBriefForCompletedRun: vi.fn(),
}));
vi.mock('../utils/extractFinalAnswer', () => ({
  extractFinalAnswer: vi.fn(),
}));
vi.mock('../utils/publishMementoCompletion', () => ({
  resolveAndPublishMementoCompletion: vi.fn(),
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      return new Proxy({}, { get: () => `mock-${String(key)}` });
    },
  }),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = vi.fn().mockResolvedValue(undefined);
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

const mockApiGwSend = vi.fn();
vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send = (...args: unknown[]) => mockApiGwSend(...args);
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { endAgentRunLiveActivity } from '../utils/liveActivityPush';
import { startEventBriefForCompletedRun } from '../briefs/eventBriefTrigger';
import { handleGateResponse } from './gateResponse';

const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), updateMetadata: vi.fn() };

const baseExecution = {
  id: 'exec-1',
  userId: 'user-1',
  sessionId: 'session-1',
  status: 'paused',
};

describe('container confidence resume', () => {
  it('routes through HTTP and atomically restores a rejected gate', async () => {
    const pendingGate = { iteration: 1, confidence: 0.1, reason: 'test', requestedAt: new Date() };
    mockFindById.mockResolvedValue({ ...baseExecution, status: 'paused', pendingGate });
    mockClearPendingGate.mockResolvedValue(true);
    mockRestoreRejectedResume.mockClear();
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    try {
      await expect(
        handleGateResponse(
          {
            executionId: 'exec-1',
            decision: 'continue',
          },
          'user-1',
          'conn-1',
          'http://ws',
          noopLogger as never
        )
      ).rejects.toThrow('401');
      expect(mockRestoreRejectedResume).toHaveBeenCalledWith('exec-1', { status: 'paused', pendingGate });
      // A Proceed is a click, so it must not spend the executor's runaway handoff budget.
      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse(String(init?.body))).toEqual({
        executionId: 'exec-1',
        connectionId: 'conn-1',
        resumedBy: 'user',
      });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

describe('gate response live activity settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGwSend.mockResolvedValue(undefined);
  });

  it('ends the activity when a confidence gate is stopped', async () => {
    const execution = { ...baseExecution, status: 'paused' };
    mockFindById.mockResolvedValue(execution);
    mockClearPendingGate.mockResolvedValue(true);
    await handleGateResponse(
      {
        executionId: 'exec-1',
        decision: 'stop',
      },
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as never
    );
    expect(endAgentRunLiveActivity).toHaveBeenCalledWith(execution, { status: 'completed' }, noopLogger);
    expect(startEventBriefForCompletedRun).toHaveBeenCalledWith('exec-1', execution, noopLogger);
  });

  describe('held low-confidence completion', () => {
    const pendingCompletion = {
      answer: 'held answer',
      replyText: 'held reply',
      totalTokens: 10,
      totalIterations: 2,
      reachedMaxIterations: false,
      lowConfidence: true,
      canReconsider: false,
    };
    const heldExecution = { ...baseExecution, status: 'paused', pendingCompletion };

    it('ends the activity when the held completion is accepted via Stop', async () => {
      mockFindById.mockResolvedValue(heldExecution);
      mockClearPendingGate.mockResolvedValue(true);
      await handleGateResponse(
        {
          executionId: 'exec-1',
          decision: 'stop',
        },
        'user-1',
        'conn-1',
        'https://endpoint',
        noopLogger as never
      );
      expect(endAgentRunLiveActivity).toHaveBeenCalledTimes(1);
      expect(endAgentRunLiveActivity).toHaveBeenCalledWith(heldExecution, { status: 'completed' }, noopLogger);
      expect(startEventBriefForCompletedRun).toHaveBeenCalledTimes(1);
      expect(startEventBriefForCompletedRun).toHaveBeenCalledWith(heldExecution.id, heldExecution, noopLogger);
    });

    it('ends the activity when Continue has nothing to reopen and accepts the held completion', async () => {
      mockFindById.mockResolvedValue(heldExecution);
      mockClearPendingGate.mockResolvedValue(true);
      vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
      vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
      try {
        await handleGateResponse(
          {
            executionId: 'exec-1',
            decision: 'continue',
          },
          'user-1',
          'conn-1',
          'https://endpoint',
          noopLogger as never
        );
      } finally {
        vi.unstubAllEnvs();
      }
      expect(endAgentRunLiveActivity).toHaveBeenCalledTimes(1);
      expect(endAgentRunLiveActivity).toHaveBeenCalledWith(heldExecution, { status: 'completed' }, noopLogger);
    });
  });
});
