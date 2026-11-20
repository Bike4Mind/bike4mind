import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFindById = vi.fn();
const mockClearPendingGate = vi.fn();
const mockRestoreRejectedResume = vi.fn();
const mockMarkComplete = vi.fn().mockResolvedValue(undefined);
const mockResolveUnsure = vi.fn();
const mockFindTicketByExecutionId = vi.fn();
const mockResumeBlockedRun = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentExecutionRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    markComplete: (...args: unknown[]) => mockMarkComplete(...args),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    restoreRejectedResume: (...args: unknown[]) => mockRestoreRejectedResume(...args),
    clearPendingGate: (...args: unknown[]) => mockClearPendingGate(...args),
  },
  loopEventRepository: { resolveUnsure: (...args: unknown[]) => mockResolveUnsure(...args) },
  workItemRepository: {
    findByExecutionId: (...args: unknown[]) => mockFindTicketByExecutionId(...args),
    resumeBlockedRun: (...args: unknown[]) => mockResumeBlockedRun(...args),
  },
}));

vi.mock('../utils/liveActivityPush', () => ({ endAgentRunLiveActivity: vi.fn() }));
vi.mock('../utils/persistRunAsQuest', () => ({
  persistRunAsQuest: vi.fn(),
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

describe('gate response on a loop run', () => {
  const pendingGate = { iteration: 2, confidence: 0.3, reason: 'thin results', requestedAt: new Date(1000) };
  const gateCmd = (decision: 'continue' | 'stop') => ({ executionId: 'exec-1', decision });
  const respond = (decision: 'continue' | 'stop') =>
    handleGateResponse(gateCmd(decision), 'user-1', 'conn-1', 'http://ws', noopLogger as never);

  beforeEach(() => {
    vi.clearAllMocks();
    mockClearPendingGate.mockResolvedValue(true);
    mockFindTicketByExecutionId.mockResolvedValue({ id: 'ticket-1', title: 'Research X' });
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 202 })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const loopRun = { ...baseExecution, status: 'paused', pendingGate, loopId: 'loop-1' };
  const expectedEvent = {
    loopId: 'loop-1',
    userId: 'user-1',
    executionId: 'exec-1',
    iteration: 2,
    confidence: 0.3,
    reason: 'thin results',
    requestedAt: pendingGate.requestedAt,
    workItemId: 'ticket-1',
    ticketTitle: 'Research X',
  };

  it('continue records the event as resumed and moves the parked ticket back to in_progress', async () => {
    mockFindById.mockResolvedValue(loopRun);
    await respond('continue');

    expect(mockClearPendingGate).toHaveBeenCalledWith('exec-1', 'resumed', 'user-1', undefined);
    expect(mockResolveUnsure).toHaveBeenCalledWith(expectedEvent, {
      outcome: 'resumed',
      by: 'user-1',
      at: expect.any(Date),
    });
    expect(mockResumeBlockedRun).toHaveBeenCalledWith('ticket-1', 'exec-1');
  });

  it('stop records the event as rejected and leaves the ticket blocked', async () => {
    mockFindById.mockResolvedValue(loopRun);
    await respond('stop');

    expect(mockClearPendingGate).toHaveBeenCalledWith('exec-1', 'rejected', 'user-1', undefined);
    expect(mockMarkComplete).toHaveBeenCalledWith('exec-1', expect.objectContaining({ stoppedByGate: true }));
    expect(mockResolveUnsure).toHaveBeenCalledWith(expectedEvent, expect.objectContaining({ outcome: 'rejected' }));
    expect(mockResumeBlockedRun).not.toHaveBeenCalled();
  });

  describe('with a held completion', () => {
    const heldLoopRun = {
      ...loopRun,
      pendingCompletion: { answer: 'held answer', replyText: 'held reply', canReconsider: false },
    };

    it('stop accepts the held answer and records the event as rejected', async () => {
      mockFindById.mockResolvedValue(heldLoopRun);
      await respond('stop');

      expect(mockClearPendingGate).toHaveBeenCalledWith('exec-1', 'rejected', 'user-1', { keepCompletion: true });
      expect(mockResolveUnsure).toHaveBeenCalledWith(expectedEvent, expect.objectContaining({ outcome: 'rejected' }));
      expect(mockResumeBlockedRun).not.toHaveBeenCalled();
    });

    it('continue with nothing to reopen accepts the held answer and records the event as resumed', async () => {
      mockFindById.mockResolvedValue(heldLoopRun);
      await respond('continue');

      expect(mockClearPendingGate).toHaveBeenCalledWith('exec-1', 'resumed', 'user-1', { keepCompletion: true });
      expect(mockResolveUnsure).toHaveBeenCalledWith(expectedEvent, expect.objectContaining({ outcome: 'resumed' }));
      expect(mockResumeBlockedRun).toHaveBeenCalledWith('ticket-1', 'exec-1');
    });
  });

  it('a rejected resume dispatch writes nothing to the loop log or ticket', async () => {
    mockFindById.mockResolvedValue(loopRun);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(respond('continue')).rejects.toThrow('401');

    expect(mockResolveUnsure).not.toHaveBeenCalled();
    expect(mockResumeBlockedRun).not.toHaveBeenCalled();
  });

  it('still resolves the gate when the loop log write fails', async () => {
    mockFindById.mockResolvedValue(loopRun);
    mockResolveUnsure.mockRejectedValueOnce(new Error('db down'));
    await respond('stop');

    expect(mockMarkComplete).toHaveBeenCalledWith('exec-1', expect.objectContaining({ stoppedByGate: true }));
    expect(noopLogger.warn).toHaveBeenCalledWith(
      '[Gate] Could not record the gate answer in the loop log',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });

  it.each(['continue', 'stop'] as const)('%s on a chat run touches no loop event or ticket', async decision => {
    mockFindById.mockResolvedValue({ ...loopRun, loopId: undefined });
    await respond(decision);

    expect(mockClearPendingGate).toHaveBeenCalled();
    expect(mockFindTicketByExecutionId).not.toHaveBeenCalled();
    expect(mockResolveUnsure).not.toHaveBeenCalled();
    expect(mockResumeBlockedRun).not.toHaveBeenCalled();
  });
});
