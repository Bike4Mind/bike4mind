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
const mockApprovePendingPermission = vi.fn();
const mockRememberDecision = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentExecutionRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    updatePermissionState: (...args: unknown[]) => mockUpdatePermissionState(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
    approvePendingPermission: (...args: unknown[]) => mockApprovePendingPermission(...args),
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

import { handlePermissionResponse } from './agentExecute';

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

    expect(mockUpdatePermissionState).not.toHaveBeenCalled();
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

  it('retries the resume dispatch when the earlier call already flipped status to continuing before dying', async () => {
    // Repro: the earlier call's `updateStatus` succeeded but it threw during the
    // Lambda dispatch that followed (not before `updateStatus`, which the
    // `awaiting_permission` case above covers) - so status is already `continuing`
    // when this retry lands, not `awaiting_permission`.
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

    expect(mockUpdatePermissionState).toHaveBeenCalledWith('exec-1', {
      pendingPermission: null,
      deniedTool: undefined,
      matchToolCallId: 'call-1',
    });
    expect(mockApprovePendingPermission).not.toHaveBeenCalled();
  });
});
