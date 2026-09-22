import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins the "Allow/Deny for Session" write path in `handlePermissionResponse`: the
 * approve/deny branches call `sessionToolApprovalRepository.rememberDecision` keyed on
 * `execution.sessionId`, which is also the key `startAgentExecution` reads back on the
 * next message. A mismatch here (or a silent throw) would make "for Session" mean
 * nothing without any test currently catching it.
 */

const mockFindById = vi.fn();
const mockUpdatePermissionState = vi.fn();
const mockMarkFailed = vi.fn();
const mockUpdateStatus = vi.fn();
const mockRestoreRejectedResume = vi.fn();
const mockClearPendingGate = vi.fn();
const mockClaimExecution = vi.fn().mockResolvedValue(true);
const mockRememberDecision = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentExecutionRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    updatePermissionState: (...args: unknown[]) => mockUpdatePermissionState(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
    restoreRejectedResume: (...args: unknown[]) => mockRestoreRejectedResume(...args),
    clearPendingGate: (...args: unknown[]) => mockClearPendingGate(...args),
    claimExecution: (...args: unknown[]) => mockClaimExecution(...args),
  },
  sessionToolApprovalRepository: {
    rememberDecision: (...args: unknown[]) => mockRememberDecision(...args),
  },
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
}));

vi.mock('@server/utils/childExecutionSnapshot', () => ({
  buildChildExecutionSnapshots: vi.fn().mockResolvedValue([]),
}));
vi.mock('@server/utils/persistRunAsQuest', () => ({
  persistRunAsQuest: vi.fn(),
}));
vi.mock('@server/utils/extractFinalAnswer', () => ({
  extractFinalAnswer: vi.fn(),
}));
vi.mock('@server/utils/startAgentExecution', () => ({
  startAgentExecution: vi.fn(),
}));
vi.mock('@server/utils/publishMementoCompletion', () => ({
  resolveAndPublishMementoCompletion: vi.fn(),
}));
vi.mock('@server/websocket/reconnectBudget', () => ({
  decideInlineBudgets: vi.fn().mockReturnValue({ includeStepsInline: true, includeChildrenInline: true }),
}));
vi.mock('@server/cli/auth', () => ({
  verifyJwtToken: vi.fn(),
  checkRateLimit: vi.fn(),
  verifyApiKey: vi.fn(),
  checkApiKeyRateLimitOrThrow: vi.fn(),
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      return new Proxy({}, { get: () => `mock-${String(key)}` });
    },
  }),
}));

const mockLambdaSend = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = (...args: unknown[]) => mockLambdaSend(...args);
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

import { handlePermissionResponse, handleGateResponse } from './agentExecute';

const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), updateMetadata: vi.fn() };

const baseCmd = (overrides: Partial<{ approved: boolean; rememberForSession: boolean; toolName: string }> = {}) => ({
  accessToken: 'token',
  action: 'agent_execute' as const,
  command: 'permission_response' as const,
  executionId: 'exec-1',
  toolName: 'web_search',
  approved: true,
  rememberForSession: false,
  ...overrides,
});

const baseExecution = {
  id: 'exec-1',
  userId: 'user-1',
  sessionId: 'session-1',
  status: 'awaiting_permission',
  pendingPermission: { toolName: 'web_search' },
};

describe('handlePermissionResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(baseExecution);
    mockApiGwSend.mockResolvedValue(undefined);
    mockLambdaSend.mockResolvedValue(undefined);
  });

  it('remembers the approval keyed on execution.sessionId when rememberForSession is true', async () => {
    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: true }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockRememberDecision).toHaveBeenCalledWith('user-1', baseExecution.sessionId, 'web_search', 'approved');
    expect(mockClaimExecution).toHaveBeenCalledWith('exec-1', ['awaiting_permission'], 'continuing');
  });

  it('does not remember the approval when rememberForSession is false', async () => {
    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockRememberDecision).not.toHaveBeenCalled();
    expect(mockClaimExecution).toHaveBeenCalledWith('exec-1', ['awaiting_permission'], 'continuing');
  });

  it('still resumes the run and logs a warning when rememberDecision rejects', async () => {
    mockRememberDecision.mockRejectedValueOnce(new Error('write failed'));

    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: true }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(noopLogger.warn).toHaveBeenCalled();
    expect(mockClaimExecution).toHaveBeenCalledWith('exec-1', ['awaiting_permission'], 'continuing');
    expect(mockLambdaSend).toHaveBeenCalled();
  });

  it('still marks the execution failed and sends a failed event on deny, regardless of persistence', async () => {
    await handlePermissionResponse(
      baseCmd({ approved: false, rememberForSession: true }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockRememberDecision).toHaveBeenCalledWith('user-1', baseExecution.sessionId, 'web_search', 'denied');
    expect(mockMarkFailed).toHaveBeenCalledWith('exec-1', {
      message: 'Execution stopped: you denied "web_search".',
    });
    expect(mockApiGwSend).toHaveBeenCalled();
    const [sentCommand] = mockApiGwSend.mock.calls[0];
    expect(sentCommand.input.Data.toString()).toContain('"action":"failed"');
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(noopLogger.warn).not.toHaveBeenCalled();
  });
});

describe('container resume rejection', () => {
  it.each([401, 503])('restores permission only for definitive rejection HTTP %s', async status => {
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
    mockFindById.mockResolvedValue(baseExecution);
    mockRestoreRejectedResume.mockClear();
    try {
      await expect(
        handlePermissionResponse(baseCmd(), 'user-1', 'conn-1', 'http://ws', noopLogger as never)
      ).rejects.toThrow(String(status));
      if (status === 401)
        expect(mockRestoreRejectedResume).toHaveBeenCalledWith('exec-1', {
          status: 'awaiting_permission',
          pendingPermission: baseExecution.pendingPermission,
        });
      else expect(mockRestoreRejectedResume).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

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
            accessToken: 'token',
            action: 'agent_execute',
            command: 'gate_response',
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

describe('concurrent permission approvals', () => {
  it('allows only the approval that claimed the pause to dispatch or roll back', async () => {
    mockFindById.mockResolvedValue(baseExecution);
    mockClaimExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockRestoreRejectedResume.mockClear();
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const results = await Promise.allSettled(
        [1, 2].map(() => handlePermissionResponse(baseCmd(), 'user-1', 'conn-1', 'http://ws', noopLogger as never))
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(mockRestoreRejectedResume).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

describe('permission resume preparation failure', () => {
  it('restores a claimed pause when preparation fails before dispatch and permits retry', async () => {
    mockFindById.mockResolvedValue(baseExecution);
    mockClaimExecution.mockResolvedValue(true);
    mockUpdatePermissionState
      .mockRejectedValueOnce(new Error('temporary DB write failure'))
      .mockResolvedValue(undefined);
    mockRestoreRejectedResume.mockClear();
    mockLambdaSend.mockClear();
    await expect(
      handlePermissionResponse(baseCmd(), 'user-1', 'conn-1', 'http://ws', noopLogger as never)
    ).rejects.toThrow('temporary DB');
    expect(mockRestoreRejectedResume).toHaveBeenCalledWith('exec-1', {
      status: 'awaiting_permission',
      pendingPermission: baseExecution.pendingPermission,
    });
    expect(mockLambdaSend).not.toHaveBeenCalled();
    await handlePermissionResponse(baseCmd(), 'user-1', 'conn-1', 'http://ws', noopLogger as never);
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });
});
