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
const mockApprovePendingPermission = vi.fn();
const mockDenyPendingPermission = vi.fn();
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
    approvePendingPermission: (...args: unknown[]) => mockApprovePendingPermission(...args),
    denyPendingPermission: (...args: unknown[]) => mockDenyPendingPermission(...args),
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

const baseCmd = (
  overrides: Partial<{ approved: boolean; rememberForSession: boolean; toolName: string; toolCallId: string }> = {}
) => ({
  accessToken: 'token',
  action: 'agent_execute' as const,
  command: 'permission_response' as const,
  executionId: 'exec-1',
  toolName: 'web_search',
  toolCallId: 'call-1',
  approved: true,
  rememberForSession: false,
  ...overrides,
});

const baseExecution = {
  id: 'exec-1',
  userId: 'user-1',
  sessionId: 'session-1',
  status: 'awaiting_permission',
  pendingPermission: { toolName: 'web_search', toolCallId: 'call-1' },
};

describe('handlePermissionResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(baseExecution);
    mockApiGwSend.mockResolvedValue(undefined);
    mockLambdaSend.mockResolvedValue(undefined);
    mockApprovePendingPermission.mockResolvedValue(true);
    mockDenyPendingPermission.mockResolvedValue(true);
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
    expect(mockUpdateStatus).toHaveBeenCalledWith('exec-1', 'continuing');
    // approvedTool rides the same CAS write as the approval, not a second one - see
    // approvePendingPermission.
    expect(mockApprovePendingPermission).toHaveBeenCalledWith('exec-1', {
      approvedTool: 'web_search',
      toolCallId: 'call-1',
    });
    expect(mockUpdatePermissionState).not.toHaveBeenCalled();
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
    expect(mockUpdateStatus).toHaveBeenCalledWith('exec-1', 'continuing');
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
    expect(mockUpdateStatus).toHaveBeenCalledWith('exec-1', 'continuing');
    expect(mockLambdaSend).toHaveBeenCalled();
  });

  it('marks the execution failed atomically in the same CAS write and sends a failed event on deny', async () => {
    await handlePermissionResponse(
      baseCmd({ approved: false, rememberForSession: true }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockRememberDecision).toHaveBeenCalledWith('user-1', baseExecution.sessionId, 'web_search', 'denied');
    expect(mockDenyPendingPermission).toHaveBeenCalledWith('exec-1', {
      toolCallId: 'call-1',
      deniedTool: 'web_search',
      errorMessage: 'Execution stopped: you denied "web_search".',
    });
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockApiGwSend).toHaveBeenCalled();
    const [sentCommand] = mockApiGwSend.mock.calls[0];
    expect(sentCommand.input.Data.toString()).toContain('"action":"failed"');
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(noopLogger.warn).not.toHaveBeenCalled();
  });

  it('marks the pause approved instead of clearing it, so the executor can still replay the withheld call', async () => {
    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockApprovePendingPermission).toHaveBeenCalledWith('exec-1', {
      approvedTool: undefined,
      toolCallId: 'call-1',
    });
    expect(mockUpdatePermissionState).not.toHaveBeenCalled();
  });

  it('ignores a response naming a stale toolCallId, even when the tool name still matches', async () => {
    // The concrete regression: one iteration withholds image_generation(cat) and
    // image_generation(dog). Client A approves cat; the executor replays it and
    // re-pauses on dog under the same toolName. Client B's still-open cat card then
    // submits its (now stale) approval - it must not be accepted for dog.
    mockFindById.mockResolvedValue({
      ...baseExecution,
      pendingPermission: { toolName: 'image_generation', toolCallId: 'call-dog' },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, toolName: 'image_generation', toolCallId: 'call-cat' }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockApprovePendingPermission).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalled();
  });

  it('answers with a progress frame instead of hanging when the response omits toolCallId on a pause that has one', async () => {
    // A pause created by the current code always carries a toolCallId, so an omitted
    // `cmd.toolCallId` here is a genuinely stale tab (old cached client), not a
    // same-tool-different-args race. Silently returning would leave that tab waiting
    // on a reply that never comes.
    mockFindById.mockResolvedValue({
      ...baseExecution,
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1' },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, toolName: 'web_search', toolCallId: undefined }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockApprovePendingPermission).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockApiGwSend).toHaveBeenCalled();
    const [sent] = mockApiGwSend.mock.calls[0];
    expect(sent.input.Data.toString()).toContain('"action":"progress"');
  });

  it('ignores a deny naming a stale toolCallId, so it cannot clear a different pause', async () => {
    mockFindById.mockResolvedValue({
      ...baseExecution,
      pendingPermission: { toolName: 'image_generation', toolCallId: 'call-dog' },
    });

    await handlePermissionResponse(
      baseCmd({ approved: false, toolName: 'image_generation', toolCallId: 'call-cat' }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockDenyPendingPermission).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('does not resume when the approval loses the CAS - the pause was already settled', async () => {
    mockApprovePendingPermission.mockResolvedValueOnce(false);

    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: true }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockRememberDecision).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
    // The card is waiting on a reply; without one it spins until the stale sweep.
    expect(mockApiGwSend).toHaveBeenCalled();
    const [sent] = mockApiGwSend.mock.calls[0];
    expect(sent.input.Data.toString()).toContain('"action":"progress"');
  });

  it('retries the resume dispatch when the CAS lost to an earlier already-approved instance of the same pause', async () => {
    // Repro: a prior call of this handler won the CAS (pendingPermission.approved
    // flipped true) but died before updateStatus/the Lambda invoke landed - e.g. the
    // process crashed, or the client never saw the ack and resent the same response.
    // The re-read below has to see that already-approved state to know this is a
    // recoverable retry, not a genuinely stale response.
    mockApprovePendingPermission.mockResolvedValueOnce(false);
    mockFindById.mockResolvedValueOnce(baseExecution).mockResolvedValueOnce({
      ...baseExecution,
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockUpdateStatus).toHaveBeenCalledWith('exec-1', 'continuing');
    expect(mockLambdaSend).toHaveBeenCalled();
    // No progress event this time - the resume itself was driven, not just reported.
    expect(mockApiGwSend).not.toHaveBeenCalled();
  });

  it('retries the resume dispatch when the FIRST read already finds the pause stuck in continuing', async () => {
    // Repro: an earlier call's `updateStatus` succeeded but it threw during the
    // Lambda dispatch that followed - so the doc is already `continuing`, with
    // `pendingPermission.approved` true, on the VERY FIRST `findById` this retry
    // makes. It must never reach (or need) the `approvePendingPermission` CAS.
    mockFindById.mockResolvedValueOnce({
      ...baseExecution,
      status: 'continuing',
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockApprovePendingPermission).not.toHaveBeenCalled();
    expect(mockLambdaSend).toHaveBeenCalled();
    expect(mockApiGwSend).not.toHaveBeenCalled();
  });

  it('does not recover a stuck continuing pause when the retry names a different toolCallId', async () => {
    mockFindById.mockResolvedValueOnce({
      ...baseExecution,
      status: 'continuing',
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, toolCallId: 'call-2', rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(mockApprovePendingPermission).not.toHaveBeenCalled();
  });

  it('retries the resume dispatch when the CAS-loss re-read finds a concurrent duplicate already stuck in continuing', async () => {
    // Repro: two concurrent responses to the same pause both clear the entry-point
    // `awaiting_permission` read before either writes. The CAS winner flips status
    // and dispatches; the loser's CAS then fails and its re-read sees `continuing`.
    mockApprovePendingPermission.mockResolvedValueOnce(false);
    mockFindById.mockResolvedValueOnce(baseExecution).mockResolvedValueOnce({
      ...baseExecution,
      status: 'continuing',
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockLambdaSend).toHaveBeenCalled();
    expect(mockApiGwSend).not.toHaveBeenCalled();
  });

  it('does not retry the resume dispatch when the CAS lost to a different, unrelated pause', async () => {
    mockApprovePendingPermission.mockResolvedValueOnce(false);
    mockFindById.mockResolvedValueOnce(baseExecution).mockResolvedValueOnce({
      ...baseExecution,
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-2', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: true, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(mockApiGwSend).toHaveBeenCalled();
  });

  it('clears the pending permission on deny, discarding the withheld calls unrun', async () => {
    await handlePermissionResponse(
      baseCmd({ approved: false, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockDenyPendingPermission).toHaveBeenCalledWith('exec-1', {
      toolCallId: 'call-1',
      deniedTool: undefined,
      errorMessage: 'Execution stopped: you denied "web_search".',
    });
    expect(mockApprovePendingPermission).not.toHaveBeenCalled();
    expect(mockUpdatePermissionState).not.toHaveBeenCalled();
  });

  it('does not resume or fail the run when denial loses the CAS to a concurrent approval that already claimed the pause', async () => {
    // Concrete interleaving: two tabs answer the same pause. Approval wins the CAS
    // first (pendingPermission.approved flips true, status may already be
    // `continuing`); this denial's CAS then loses. It must not clear the pause, must
    // not mark the run failed, and must report current status instead of hanging.
    mockDenyPendingPermission.mockResolvedValueOnce(false);
    mockFindById.mockResolvedValueOnce(baseExecution).mockResolvedValueOnce({
      ...baseExecution,
      status: 'continuing',
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: false, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockRememberDecision).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalled();
    expect(mockApiGwSend).toHaveBeenCalled();
    const [sent] = mockApiGwSend.mock.calls[0];
    expect(sent.input.Data.toString()).toContain('"action":"progress"');
    expect(sent.input.Data.toString()).toContain('"status":"continuing"');
  });

  it('does not let a denial that loses the CAS clear a pause a subsequent approval is about to claim', async () => {
    // Same race, opposite ordering: this denial's CAS loses because a concurrent
    // approval already CAS-won first, even though the resume dispatch has not run
    // yet (status still awaiting_permission). Denial must still back off rather
    // than clearing/failing the run out from under the approval in flight.
    mockDenyPendingPermission.mockResolvedValueOnce(false);
    mockFindById.mockResolvedValueOnce(baseExecution).mockResolvedValueOnce({
      ...baseExecution,
      pendingPermission: { toolName: 'web_search', toolCallId: 'call-1', approved: true },
    });

    await handlePermissionResponse(
      baseCmd({ approved: false, rememberForSession: false }),
      'user-1',
      'conn-1',
      'https://endpoint',
      noopLogger as any
    );

    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockUpdatePermissionState).not.toHaveBeenCalled();
    expect(mockApiGwSend).toHaveBeenCalled();
    const [sent] = mockApiGwSend.mock.calls[0];
    expect(sent.input.Data.toString()).toContain('"action":"progress"');
  });
});

describe('container resume rejection', () => {
  it.each([401, 503])('restores permission only for definitive rejection HTTP %s', async status => {
    vi.stubEnv('AGENT_EXECUTOR_SERVICE', 'http://agentexecutor:8080');
    vi.stubEnv('AGENT_EXECUTOR_INTERNAL_SECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
    mockFindById.mockResolvedValue(baseExecution);
    mockApprovePendingPermission.mockResolvedValue(true);
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
  it('allows only the approval that won the CAS to dispatch or roll back', async () => {
    mockFindById.mockResolvedValue(baseExecution);
    mockApiGwSend.mockResolvedValue(undefined);
    mockApprovePendingPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
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
  it('dispatches nothing when preparation fails before dispatch, and permits a retry that dispatches once', async () => {
    // The status flip is the last step before the dispatch, so a failure there hands
    // the executor nothing and leaves the doc short of `continuing` - the state
    // `restoreRejectedResume` CASes on. There is nothing to roll back; the pause stays
    // marked approved, which is what the CAS-loss retry path recovers from.
    mockFindById.mockResolvedValue(baseExecution);
    mockApprovePendingPermission.mockResolvedValue(true);
    mockUpdateStatus.mockRejectedValueOnce(new Error('temporary DB write failure')).mockResolvedValue(undefined);
    mockRestoreRejectedResume.mockClear();
    mockLambdaSend.mockClear();
    await expect(
      handlePermissionResponse(baseCmd(), 'user-1', 'conn-1', 'http://ws', noopLogger as never)
    ).rejects.toThrow('temporary DB');
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(mockRestoreRejectedResume).not.toHaveBeenCalled();
    await handlePermissionResponse(baseCmd(), 'user-1', 'conn-1', 'http://ws', noopLogger as never);
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });
});
