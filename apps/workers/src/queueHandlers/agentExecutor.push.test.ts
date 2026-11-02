import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishAgentTerminalPush, withAgentTerminalPush, type AgentPushDeps } from './agentExecutor.push';

const EXECUTION = {
  userId: 'user-1',
  sessionId: 'session-1',
  linkedQuestId: 'quest-1',
};

const logger = { warn: vi.fn() };

function makeDeps(execution: Awaited<ReturnType<AgentPushDeps['findExecution']>> = EXECUTION) {
  return {
    findExecution: vi.fn(async () => execution),
    findSessionName: vi.fn(async () => 'Q3 plan'),
    sessionDeepLink: (sessionId: string) => `https://app.example.test/notebooks/${sessionId}`,
    publish: vi.fn(async () => undefined),
  } satisfies AgentPushDeps;
}

describe('withAgentTerminalPush', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes agent_completed after the completed frame is sent', async () => {
    const order: string[] = [];
    const deps = makeDeps();
    deps.publish.mockImplementation(async () => void order.push('push'));
    const sendWs = withAgentTerminalPush(async () => void order.push('frame'), deps, logger);

    await sendWs('completed', { executionId: 'exec-1', answer: 'done' });

    expect(order).toEqual(['frame', 'push']);
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      category: 'agent_completed',
      title: 'Agent finished',
      body: 'Your agent finished its task in "Q3 plan".',
      deepLink: 'https://app.example.test/notebooks/session-1',
      collapseId: 'agent-run:exec-1',
      sessionId: 'session-1',
      questId: 'quest-1',
    });
  });

  it('publishes agent_failed under the same collapse id from any failure site', async () => {
    const deps = makeDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await sendWs('failed', { executionId: 'exec-1', reason: 'insufficient_credits' });
    await sendWs('failed', { executionId: 'exec-1', reason: 'error', message: 'Something went wrong' });

    expect(deps.publish).toHaveBeenCalledTimes(2);
    for (const [event] of deps.publish.mock.calls as unknown as Array<
      [{ category: string; collapseId: string; body: string }]
    >) {
      expect(event.category).toBe('agent_failed');
      expect(event.collapseId).toBe('agent-run:exec-1');
      expect(event.body).toBe('Your agent could not finish its task in "Q3 plan".');
    }
  });

  it('does not push a user abort or a non-terminal frame', async () => {
    const deps = makeDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await sendWs('failed', { executionId: 'exec-1', reason: 'aborted' });
    await sendWs('progress', { executionId: 'exec-1', status: 'Thinking' });
    await sendWs('resumed', { executionId: 'exec-1' });

    expect(deps.findExecution).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('never fails the run when the push cannot be built or published', async () => {
    const deps = makeDeps();
    deps.findExecution.mockRejectedValue(new Error('db down'));
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await expect(sendWs('completed', { executionId: 'exec-1' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('[Push] agent terminal push failed', expect.any(Object));
  });
});

describe('publishAgentTerminalPush', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['subagent child', { ...EXECUTION, parentExecutionId: 'parent-1' }],
    ['background subagent child', { ...EXECUTION, spawnedByExecutionId: 'parent-1' }],
    ['DAG node', { ...EXECUTION, dagNodeId: 'node-a' }],
    ['missing execution', null],
  ])('skips a %s', async (_label, execution) => {
    const deps = makeDeps(execution);
    await publishAgentTerminalPush({ executionId: 'exec-1', outcome: 'completed' }, deps, logger);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('omits the session clause when the session has no name', async () => {
    const deps = makeDeps();
    deps.findSessionName.mockResolvedValue(undefined as never);
    await publishAgentTerminalPush({ executionId: 'exec-1', outcome: 'completed' }, deps, logger);
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({ body: 'Your agent finished its task.' }));
  });
});
