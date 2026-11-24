import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIEF_TRIGGER_FLUSH_TIMEOUT_MS,
  withAgentBriefTrigger,
  type AgentBriefTriggerDeps,
} from './agentExecutor.briefTrigger';
import type { AgentPushSender } from './agentExecutor.push';

type Execution = Awaited<ReturnType<AgentBriefTriggerDeps['findExecution']>>;

const TOP_LEVEL: Execution = { userId: 'user-1' };

const makeInner = () =>
  Object.assign(
    vi.fn(async () => undefined),
    { flush: vi.fn(async () => undefined) }
  );

function setup(execution: Execution = TOP_LEVEL) {
  const inner = makeInner();
  const deps = {
    findExecution: vi.fn(async () => execution),
    startEventBrief: vi.fn(async () => 'enqueued' as const),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const send = withAgentBriefTrigger(inner as unknown as AgentPushSender, deps, logger);
  return { inner, deps, logger, send };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('withAgentBriefTrigger', () => {
  it('starts one event brief for a completed top-level run, after forwarding the frame', async () => {
    const { inner, deps, logger, send } = setup();
    await send('completed', { executionId: 'exec-1' });
    await send.flush();

    expect(inner).toHaveBeenCalledWith('completed', { executionId: 'exec-1' });
    expect(deps.findExecution).toHaveBeenCalledWith('exec-1');
    expect(deps.startEventBrief).toHaveBeenCalledTimes(1);
    expect(deps.startEventBrief).toHaveBeenCalledWith('user-1');
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ executionId: 'exec-1', outcome: 'enqueued' })
    );
  });

  it.each(['failed', 'aborted', 'cancelled', 'progress'])('does not trigger on %s', async action => {
    const { inner, deps, send } = setup();
    await send(action, { executionId: 'exec-1' });
    await send.flush();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(deps.findExecution).not.toHaveBeenCalled();
    expect(deps.startEventBrief).not.toHaveBeenCalled();
  });

  it.each([
    ['a subagent', { userId: 'user-1', parentExecutionId: 'parent-1' }],
    ['a spawned run', { userId: 'user-1', spawnedByExecutionId: 'parent-1' }],
    ['a DAG node child', { userId: 'user-1', dagNodeId: 'node-1' }],
    ['a missing execution', null],
  ] as const)('does not start a brief for %s', async (_label, execution) => {
    const { deps, send } = setup(execution);
    await send('completed', { executionId: 'exec-1' });
    await send.flush();
    expect(deps.findExecution).toHaveBeenCalledTimes(1);
    expect(deps.startEventBrief).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ executionId: 42 }], [{ executionId: null }]])(
    'does not look up a run without a string executionId (%j)',
    async payload => {
      const { inner, deps, send } = setup();
      await send('completed', payload);
      await send.flush();
      expect(inner).toHaveBeenCalledTimes(1);
      expect(deps.findExecution).not.toHaveBeenCalled();
    }
  );

  it.each(['findExecution', 'startEventBrief'] as const)(
    'keeps the send resolved and logs a warning when %s rejects',
    async failing => {
      const { deps, logger, send } = setup();
      deps[failing].mockRejectedValue(new Error('boom'));
      await expect(send('completed', { executionId: 'exec-1' })).resolves.toBeUndefined();
      await expect(send.flush()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ executionId: 'exec-1', error: 'boom' })
      );
    }
  );

  it('resolves the send before the brief start settles, and flush waits for it', async () => {
    const { deps, send } = setup();
    const gate = deferred<'enqueued'>();
    deps.startEventBrief.mockReturnValue(gate.promise);

    await send('completed', { executionId: 'exec-1' });
    await vi.waitFor(() => expect(deps.startEventBrief).toHaveBeenCalledTimes(1));

    let flushed = false;
    const flushing = send.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    gate.resolve('enqueued');
    await flushing;
    expect(flushed).toBe(true);
  });

  it('flushes the inner sender before waiting on pending starts', async () => {
    const { inner, send } = setup();
    await send.flush();
    expect(inner.flush).toHaveBeenCalledTimes(1);
  });

  it('caps the flush wait at the timeout when a brief start hangs', async () => {
    vi.useFakeTimers();
    const { deps, send } = setup();
    deps.startEventBrief.mockReturnValue(new Promise(() => undefined));

    await send('completed', { executionId: 'exec-1' });
    await vi.waitFor(() => expect(deps.startEventBrief).toHaveBeenCalledTimes(1));

    let flushed = false;
    const flushing = send.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(BRIEF_TRIGGER_FLUSH_TIMEOUT_MS - 1);
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(flushed).toBe(true);
  });
});
