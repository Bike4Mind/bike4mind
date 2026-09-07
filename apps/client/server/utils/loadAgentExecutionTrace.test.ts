// @vitest-environment node
/**
 * The trace loader is the single read path behind both the SPA-internal route and the
 * public, API-key-reachable one, so its two guarantees are tested here rather than in
 * either route: who may read a run, and that `error` is safe to publish.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindExecution, mockFindSession } = vi.hoisted(() => ({
  mockFindExecution: vi.fn(),
  mockFindSession: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: { findById: mockFindExecution },
  sessionRepository: { findById: mockFindSession },
}));

const { loadAgentExecutionTrace } = await import('./loadAgentExecutionTrace');

const baseExecution = {
  id: 'exec1',
  status: 'failed' as const,
  userId: 'u1',
  sessionId: 's1',
  result: null,
  checkpoint: null,
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  updatedAt: new Date('2026-08-24T00:01:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindSession.mockResolvedValue({ id: 's1', userId: 'u1' });
});

describe('loadAgentExecutionTrace error projection', () => {
  it('sanitizes an unflagged failure, so infrastructure identifiers never reach the caller', async () => {
    // The real shape of a Bedrock denial: the role ARN carries the AWS account id, the
    // role name and the stage. Publishing it verbatim is what this guards.
    const raw =
      'AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/stage-AgentExecutor-abc/x ' +
      'is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/m';
    mockFindExecution.mockResolvedValue({ ...baseExecution, error: { message: raw } });

    const trace = await loadAgentExecutionTrace('exec1', 'u1');

    expect(trace?.error).not.toContain('123456789012');
    expect(trace?.error).not.toContain('assumed-role');
    // Collapses all the way to generic: the sanitizer matches on 'access denied' with a
    // space, which `AccessDeniedException` does not contain. Fine here - a coarser
    // message is the safe direction - but it means an auth failure is not self-describing
    // to the caller, and the operator has to read the logs.
    expect(trace?.error).toBe('Agent execution failed');
  });

  it('collapses an unrecognized internal exception to the generic message', async () => {
    mockFindExecution.mockResolvedValue({
      ...baseExecution,
      error: { message: 'MongoServerError: connection <monitor> to 10.0.3.14:27017 closed' },
    });

    const trace = await loadAgentExecutionTrace('exec1', 'u1');

    expect(trace?.error).toBe('Agent execution failed');
  });

  it('publishes a callerSafe message verbatim, so the gated tool stays named', async () => {
    // The contract documents that a run blocked by an approval gate names the tool in
    // `error` and tells the caller to add it to `tools`. Sanitizing this would collapse
    // it to the generic string and break that documented remedy.
    const message =
      'Execution stopped: tool "current_datetime" requires approval, and this run was started ' +
      'without an interactive client to approve it.';
    mockFindExecution.mockResolvedValue({ ...baseExecution, error: { message, callerSafe: true } });

    const trace = await loadAgentExecutionTrace('exec1', 'u1');

    expect(trace?.error).toBe(message);
  });

  it('leaves error null on a run that did not fail', async () => {
    mockFindExecution.mockResolvedValue({
      ...baseExecution,
      status: 'completed' as const,
      result: { answer: 'done', steps: [], totalIterations: 1 },
    });

    const trace = await loadAgentExecutionTrace('exec1', 'u1');

    expect(trace?.error).toBeNull();
    expect(trace?.answer).toBe('done');
  });
});

describe('loadAgentExecutionTrace authorization', () => {
  it('returns null for a missing execution', async () => {
    mockFindExecution.mockResolvedValue(null);
    expect(await loadAgentExecutionTrace('exec1', 'u1')).toBeNull();
  });

  it('returns null when the linked session belongs to someone else', async () => {
    mockFindExecution.mockResolvedValue({ ...baseExecution, error: { message: 'boom' } });
    mockFindSession.mockResolvedValue({ id: 's1', userId: 'someone-else' });

    expect(await loadAgentExecutionTrace('exec1', 'u1')).toBeNull();
  });

  it('falls back to a direct owner check when the run has no session linkage', async () => {
    mockFindExecution.mockResolvedValue({ ...baseExecution, sessionId: null, userId: 'someone-else' });

    expect(await loadAgentExecutionTrace('exec1', 'u1')).toBeNull();
    expect(mockFindSession).not.toHaveBeenCalled();
  });
});
