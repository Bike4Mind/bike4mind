import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import {
  endAgentLiveActivity,
  publishAgentTerminalPush,
  withAgentTerminalPush,
  type AgentPushDeps,
} from './agentExecutor.push';

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
  beforeEach(() => {
    vi.clearAllMocks();
    pushDelivery.configured = true;
  });

  it('returns the sender unwrapped while push delivery is unconfigured', async () => {
    pushDelivery.configured = false;
    const deps = makeDeps();
    const raw = vi.fn(async () => undefined);
    const sendWs = withAgentTerminalPush(raw, deps, logger);

    expect(sendWs).toBe(raw);
    await publishAgentTerminalPush({ executionId: 'exec-1', outcome: 'completed' }, deps, logger);
    expect(deps.findExecution).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

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

describe('withAgentTerminalPush live activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushDelivery.configured = true;
  });

  function makeLiveDeps(execution: Awaited<ReturnType<AgentPushDeps['findExecution']>> = EXECUTION) {
    return { ...makeDeps(execution), publishLiveActivity: vi.fn(async () => undefined) };
  }

  it('reads and publishes nothing for any frame while push delivery is unconfigured', async () => {
    pushDelivery.configured = false;
    const deps = makeLiveDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await sendWs('progress', { executionId: 'exec-1', status: 'Searching' });
    await sendWs('completed', { executionId: 'exec-1' });
    await endAgentLiveActivity({ executionId: 'exec-1', outcome: 'failed' }, deps, logger);

    expect(deps.findExecution).not.toHaveBeenCalled();
    expect(deps.publishLiveActivity).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  const sentEvents = (deps: ReturnType<typeof makeLiveDeps>) =>
    deps.publishLiveActivity.mock.calls.map(([event]) => event);

  it('does nothing without a publishLiveActivity dependency', async () => {
    const deps = makeDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);
    await sendWs('progress', { executionId: 'exec-1', status: 'Searching' });
    expect(deps.findExecution).not.toHaveBeenCalled();
  });

  it('turns a status line into a running update keyed by the run quest', async () => {
    const deps = makeLiveDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await sendWs('progress', { executionId: 'exec-1', status: 'Searching the web' });

    expect(sentEvents(deps)).toEqual([
      {
        userId: 'user-1',
        questId: 'quest-1',
        event: 'update',
        contentState: { status: 'running', stageLabel: 'Searching the web' },
      },
    ]);
  });

  it('labels tool steps and ignores thoughts', async () => {
    const deps = makeLiveDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await sendWs('iteration_step', { executionId: 'exec-1', step: { type: 'thought', content: 'hm' } });
    await sendWs('iteration_step', {
      executionId: 'exec-1',
      step: { type: 'action', content: 'x', metadata: { toolName: 'web_search', timestamp: 1 } },
    });

    expect(sentEvents(deps).map(e => e.contentState.stageLabel)).toEqual(['Using web_search']);
  });

  it('sends approval and confidence-gate pauses immediately, inside the throttle window', async () => {
    const deps = makeLiveDeps();
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await sendWs('progress', { executionId: 'exec-1', status: 'Searching' });
    await sendWs('progress', { executionId: 'exec-1', questId: 'quest-1', pendingAction: { tool: 'create_issue' } });
    await sendWs('progress', { executionId: 'exec-1', status: 'paused' });

    expect(sentEvents(deps).map(e => e.contentState.status)).toEqual(['running', 'approval_needed', 'paused']);
  });

  it('ends the activity on completed, failed and a user abort', async () => {
    const outcomes: Array<[string, Record<string, unknown>, unknown]> = [
      ['completed', {}, { status: 'completed' }],
      ['failed', { reason: 'error' }, { status: 'failed', errored: true }],
      ['failed', { reason: 'aborted' }, { status: 'stopped' }],
    ];
    for (const [action, extra, contentState] of outcomes) {
      const deps = makeLiveDeps();
      const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);
      await sendWs(action, { executionId: 'exec-1', ...extra });
      expect(sentEvents(deps)).toEqual([{ userId: 'user-1', questId: 'quest-1', event: 'end', contentState }]);
    }
  });

  it('skips child runs and runs without a quest', async () => {
    for (const execution of [
      { ...EXECUTION, parentExecutionId: 'p' },
      { ...EXECUTION, dagNodeId: 'n' },
      { ...EXECUTION, linkedQuestId: undefined },
    ]) {
      const deps = makeLiveDeps(execution);
      const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);
      await sendWs('progress', { executionId: 'exec-1', status: 'Working' });
      expect(deps.publishLiveActivity).not.toHaveBeenCalled();
    }
  });

  it('never lets a live activity failure break the frame or the terminal push', async () => {
    const deps = makeLiveDeps();
    deps.findExecution.mockRejectedValueOnce(new Error('db down'));
    const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);

    await expect(sendWs('progress', { executionId: 'exec-1', status: 'Working' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('[LiveActivity] agent progress frame failed', expect.anything());
    await sendWs('completed', { executionId: 'exec-1' });
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it('throttles status lines to one per window with the latest flushed after it', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeLiveDeps();
      const sendWs = withAgentTerminalPush(async () => undefined, deps, logger);
      await sendWs('progress', { executionId: 'exec-1', status: 'one' });
      await sendWs('progress', { executionId: 'exec-1', status: 'two' });
      await sendWs('progress', { executionId: 'exec-1', status: 'three' });
      expect(deps.publishLiveActivity).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(sentEvents(deps).map(e => e.contentState.stageLabel)).toEqual(['one', 'three']);
    } finally {
      vi.useRealTimers();
    }
  });
});
