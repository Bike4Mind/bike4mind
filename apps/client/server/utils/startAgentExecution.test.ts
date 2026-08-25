import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResource = vi.hoisted(() => ({ AgentExecutor: { name: 'agent-executor-fn' } }));
vi.mock('sst', () => ({ Resource: mockResource }));

const {
  mockSend,
  mockSessionFindById,
  mockOrgFindById,
  mockCleanupStaleActive,
  mockCountActive,
  mockCreateExecution,
  mockQuestCreate,
  mockQuestDeleteOne,
  mockSettleStrandedQuests,
  mockPersistLinkedQuestId,
  mockResolveExecutorName,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSessionFindById: vi.fn(),
  mockOrgFindById: vi.fn(),
  mockCleanupStaleActive: vi.fn(),
  mockCountActive: vi.fn(),
  mockCreateExecution: vi.fn(),
  mockQuestCreate: vi.fn(),
  mockQuestDeleteOne: vi.fn(),
  mockSettleStrandedQuests: vi.fn(),
  mockPersistLinkedQuestId: vi.fn(),
  mockResolveExecutorName: vi.fn(),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockSend;
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: mockSessionFindById },
  organizationRepository: { findById: mockOrgFindById },
  agentExecutionRepository: {
    cleanupStaleActive: mockCleanupStaleActive,
    countActiveByUserId: mockCountActive,
    create: mockCreateExecution,
    persistLinkedQuestId: mockPersistLinkedQuestId,
  },
  Quest: { create: mockQuestCreate, deleteOne: mockQuestDeleteOne },
}));

vi.mock('@server/utils/settleStrandedQuests', () => ({
  settleStrandedQuests: mockSettleStrandedQuests,
}));

vi.mock('@server/utils/agentExecutorFunctionName', () => ({
  resolveAgentExecutorFunctionName: mockResolveExecutorName,
}));

import { startAgentExecution } from './startAgentExecution';
import { HEADLESS_CONNECTION_ID } from './headlessConnection';
import { MAX_CONCURRENT_EXECUTIONS_PER_USER } from './executionLimits';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

/**
 * Every test uses a DISTINCT userId: the stale-active sweep is memoized per user in
 * module scope, so a shared id would silently skip `cleanupStaleActive` for every test
 * after the first. The session mock echoes whichever caller `input()` last built, so
 * the ownership check passes unless a test deliberately overrides it.
 */
let currentUserId = 'u1';

const input = (overrides: { userId: string } & Record<string, unknown>) => {
  currentUserId = overrides.userId;
  return {
    sessionId: 's1',
    questId: 's1',
    query: 'optimize this',
    model: 'claude-opus-5',
    connectionId: HEADLESS_CONNECTION_ID,
    ...overrides,
  };
};

/** The JSON payload handed to the executor Lambda on the most recent invoke. */
function dispatchedPayload(): Record<string, unknown> {
  const command = mockSend.mock.calls.at(-1)?.[0] as { input: { Payload: Buffer } };
  return JSON.parse(command.input.Payload.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionFindById.mockImplementation(async (id: string) => ({ id, userId: currentUserId }));
  mockCleanupStaleActive.mockResolvedValue([]);
  mockCountActive.mockResolvedValue(0);
  mockCreateExecution.mockResolvedValue({ id: 'exec1' });
  mockQuestCreate.mockResolvedValue({ id: 'quest1' });
  mockQuestDeleteOne.mockResolvedValue(undefined);
  mockSend.mockResolvedValue(undefined);
  mockPersistLinkedQuestId.mockResolvedValue(undefined);
  mockResolveExecutorName.mockReturnValue('agent-executor-fn');
});

describe('startAgentExecution', () => {
  it('creates the execution, persists the prompt Quest, and dispatches the Lambda', async () => {
    const result = await startAgentExecution(input({ userId: 'happy-path' }), logger);

    expect(result).toEqual({ ok: true, executionId: 'exec1', questId: 'quest1' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(dispatchedPayload()).toMatchObject({
      executionId: 'exec1',
      userId: 'happy-path',
      sessionId: 's1',
      // The REAL Quest id, never the sessionId back-reference: the executor keys the
      // client's optimistic-bubble swap off this field.
      questId: 'quest1',
      connectionId: HEADLESS_CONNECTION_ID,
    });
    // Also stamped on the execution doc, so a checkpointed continuation - which never
    // sees the start payload - can still key lake-access audit rows to the real Quest.
    expect(mockPersistLinkedQuestId).toHaveBeenCalledWith('exec1', 'quest1');
  });

  it('rejects a session the caller does not own without creating anything', async () => {
    const cmd = input({ userId: 'not-owner' });
    mockSessionFindById.mockResolvedValue({ id: 's1', userId: 'someone-else' });

    const result = await startAgentExecution(cmd, logger);

    expect(result).toEqual({
      ok: false,
      reason: 'session_not_found',
      message: 'Session not found or unauthorized',
    });
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a missing session', async () => {
    const cmd = input({ userId: 'no-session' });
    mockSessionFindById.mockResolvedValue(null);

    const result = await startAgentExecution(cmd, logger);

    expect(result).toMatchObject({ ok: false, reason: 'session_not_found' });
    expect(mockCreateExecution).not.toHaveBeenCalled();
  });

  it('rejects an organization the caller does not belong to', async () => {
    mockOrgFindById.mockResolvedValue({ userId: 'owner', managerId: 'mgr', users: [{ userId: 'other' }] });

    const result = await startAgentExecution(input({ userId: 'outsider', organizationId: 'org1' }), logger);

    expect(result).toMatchObject({ ok: false, reason: 'organization_not_found' });
    expect(mockCreateExecution).not.toHaveBeenCalled();
  });

  it('accepts an organization the caller is a plain member of', async () => {
    mockOrgFindById.mockResolvedValue({ userId: 'owner', users: [{ userId: 'member' }] });

    const result = await startAgentExecution(input({ userId: 'member', organizationId: 'org1' }), logger);

    expect(result).toMatchObject({ ok: true });
    expect(dispatchedPayload()).toMatchObject({ organizationId: 'org1' });
  });

  it('refuses to start past the concurrency cap and records the rejection in chat history', async () => {
    mockCountActive.mockResolvedValue(MAX_CONCURRENT_EXECUTIONS_PER_USER);

    const result = await startAgentExecution(input({ userId: 'at-cap' }), logger);

    expect(result).toMatchObject({ ok: false, reason: 'concurrent_limit' });
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    // The refusal is written into the session so a reload does not show an empty notebook.
    expect(mockQuestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        status: 'done',
        replies: [expect.stringContaining('already running')],
      })
    );
  });

  it('sweeps stale executions and settles their stranded quests before counting', async () => {
    mockCleanupStaleActive.mockResolvedValue([{ id: 'stale1' }]);

    await startAgentExecution(input({ userId: 'has-stale' }), logger);

    expect(mockCleanupStaleActive).toHaveBeenCalledWith('has-stale', expect.any(Number));
    expect(mockSettleStrandedQuests).toHaveBeenCalledWith([{ id: 'stale1' }], logger, '[Start]');
  });

  it('skips the sweep for a repeat start by the same user inside the memo window', async () => {
    await startAgentExecution(input({ userId: 'repeat-caller' }), logger);
    await startAgentExecution(input({ userId: 'repeat-caller' }), logger);

    expect(mockCleanupStaleActive).toHaveBeenCalledTimes(1);
  });

  it('pre-approves the caller-named tools on a headless run, so the first gated tool does not kill it', async () => {
    await startAgentExecution(
      input({ userId: 'headless-approves', enabledTools: ['web_search', 'current_datetime'] }),
      logger
    );

    expect(mockCreateExecution).toHaveBeenCalledWith(
      expect.objectContaining({ approvedTools: ['web_search', 'current_datetime'] })
    );
  });

  it('leaves approvedTools empty for an interactive run, which can approve per-tool instead', async () => {
    await startAgentExecution(
      input({ userId: 'interactive-run', connectionId: 'real-ws-conn', enabledTools: ['web_search'] }),
      logger
    );

    expect(mockCreateExecution).toHaveBeenCalledWith(expect.objectContaining({ approvedTools: [] }));
  });

  it('refuses before creating anything when the executor is not linked to this deployment', async () => {
    // The frontend server links the executor's NAME, not the function, so a
    // hard-coded `Resource.AgentExecutor` resolves in the WebSocket Lambda and throws
    // in the web one - a 502 in exactly one transport. Bail before any write so a
    // deployment gap cannot leave an orphan execution or a reply-less prompt bubble.
    mockResolveExecutorName.mockReturnValue(undefined);

    const result = await startAgentExecution(input({ userId: 'unlinked-deploy' }), logger);

    expect(result).toMatchObject({ ok: false, reason: 'dispatch_failed' });
    expect(mockCreateExecution).not.toHaveBeenCalled();
    expect(mockQuestCreate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('not linked to this deployment'),
      expect.anything()
    );
  });

  it('dispatches to the resolved executor function name', async () => {
    mockResolveExecutorName.mockReturnValue('resolved-executor-name');

    await startAgentExecution(input({ userId: 'resolves-name' }), logger);

    const command = mockSend.mock.calls.at(-1)?.[0] as { input: { FunctionName: string } };
    expect(command.input.FunctionName).toBe('resolved-executor-name');
  });

  it('tears down the dispatch-time Quest when the Lambda invoke fails', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));

    const result = await startAgentExecution(input({ userId: 'invoke-fails' }), logger);

    expect(result).toMatchObject({ ok: false, reason: 'dispatch_failed', executionId: 'exec1' });
    expect(mockQuestDeleteOne).toHaveBeenCalledWith({ _id: 'quest1' });
  });

  it('still dispatches when the prompt Quest write fails, omitting questId', async () => {
    mockQuestCreate.mockRejectedValue(new Error('write concern'));

    const result = await startAgentExecution(input({ userId: 'quest-write-fails' }), logger);

    expect(result).toEqual({ ok: true, executionId: 'exec1', questId: undefined });
    expect(dispatchedPayload().questId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist user prompt Quest'),
      expect.anything()
    );
  });
});
