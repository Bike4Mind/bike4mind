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

describe('loadAgentExecutionTrace viewer redaction', () => {
  const steps = [
    {
      type: 'action',
      content: 'read_file',
      metadata: { toolName: 'read_file', toolInput: { path: 'owner-only-argument' }, timestamp: 1, iteration: 0 },
    },
    {
      type: 'observation',
      content: 'verbatim tool output',
      metadata: { toolName: 'read_file', confidenceReason: 'owner-only reasoning', timestamp: 2 },
    },
    { type: 'final_answer', content: 'summary', metadata: { timestamp: 3 } },
  ];
  const completed = {
    ...baseExecution,
    status: 'completed' as const,
    result: { answer: 'summary', steps, totalIterations: 1 },
  };

  it('keeps observation content for the session owner', async () => {
    mockFindExecution.mockResolvedValue(completed);

    const trace = await loadAgentExecutionTrace('exec1', 'u1');

    expect(trace?.isOwner).toBe(true);
    expect(trace?.steps[1].content).toBe('verbatim tool output');
  });

  it('blanks observation content for a share holder while keeping the rest of the trace', async () => {
    mockFindExecution.mockResolvedValue(completed);
    mockFindSession.mockResolvedValue({ id: 's1', userId: 'owner', users: [{ userId: 'viewer' }] });

    const trace = await loadAgentExecutionTrace('exec1', 'viewer');

    expect(trace?.isOwner).toBe(false);
    expect(trace?.steps.map(step => step.type)).toEqual(['action', 'observation', 'final_answer']);
    expect(trace?.steps[1].content).toBe('');
    expect(trace?.steps[0].content).toBe('read_file');
    expect(trace?.steps[0].metadata).toEqual({ toolName: 'read_file', timestamp: 1, iteration: 0 });
    expect(trace?.steps[1].metadata).toEqual({ toolName: 'read_file', timestamp: 2 });
    expect(trace?.answer).toBe('summary');
  });

  it('keeps tool input and confidence text for the session owner', async () => {
    mockFindExecution.mockResolvedValue(completed);

    const trace = await loadAgentExecutionTrace('exec1', 'u1');

    expect(trace?.steps[0].metadata?.toolInput).toEqual({ path: 'owner-only-argument' });
    expect(trace?.steps[1].metadata?.confidenceReason).toBe('owner-only reasoning');
  });

  it('applies the same redaction to the live checkpoint of an in-flight run', async () => {
    mockFindExecution.mockResolvedValue({
      ...baseExecution,
      status: 'running' as const,
      checkpoint: { steps, iteration: 1 },
    });
    mockFindSession.mockResolvedValue({ id: 's1', userId: 'owner', users: [{ userId: 'viewer' }] });

    const trace = await loadAgentExecutionTrace('exec1', 'viewer');

    expect(JSON.stringify(trace?.steps)).not.toContain('verbatim tool output');
    expect(JSON.stringify(trace?.steps)).not.toContain('owner-only-argument');
    expect(JSON.stringify(trace?.steps)).not.toContain('owner-only reasoning');
  });

  it('keeps observation content for the user who started the run', async () => {
    mockFindExecution.mockResolvedValue({ ...completed, userId: 'editor' });
    mockFindSession.mockResolvedValue({ id: 's1', userId: 'owner', users: [{ userId: 'editor' }] });

    expect((await loadAgentExecutionTrace('exec1', 'editor'))?.steps[1].content).toBe('verbatim tool output');
  });
});

describe('loadAgentExecutionTrace step progress', () => {
  it('is null for a run without a captured plan, so clients fall back to indeterminate progress', async () => {
    mockFindExecution.mockResolvedValue({ ...baseExecution, status: 'running' as const });

    expect((await loadAgentExecutionTrace('exec1', 'u1'))?.stepProgress).toBeNull();
  });

  it('reports solved plan steps against the plan length', async () => {
    mockFindExecution.mockResolvedValue({
      ...baseExecution,
      status: 'running' as const,
      optiPlanState: {
        decomposeUsed: true,
        steps: [
          { family: 'scheduling', title: 'Shifts' },
          { family: 'routing', title: 'Routes' },
        ],
        solved: { scheduling: 1 },
        results: {},
      },
    });

    expect((await loadAgentExecutionTrace('exec1', 'u1'))?.stepProgress).toEqual({ completed: 1, total: 2 });
  });

  it('is null after a decompose that captured no steps', async () => {
    mockFindExecution.mockResolvedValue({
      ...baseExecution,
      status: 'running' as const,
      optiPlanState: { decomposeUsed: true, steps: [] },
    });

    expect((await loadAgentExecutionTrace('exec1', 'u1'))?.stepProgress).toBeNull();
  });
});
