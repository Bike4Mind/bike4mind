import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestGraphDocument, IQuestNodeDocument, NodeStatus } from '@bike4mind/common';

/**
 * The tick executor: the half of the scheduler that spends money and writes.
 *
 * `planSchedulerTick` is pure and covered next door. Everything here is the part
 * that sums credits, derives elapsed time, orders spine writes against the
 * decision, gates dispatch, and swallows failures - and it is deliberately run
 * against the REAL decision function, so a change that makes the two disagree
 * shows up here rather than passing against a mock.
 */

const updateState = vi.fn();
const updateStatus = vi.fn();
const countActiveByUserId = vi.fn();
const tryIncrementWithinLimitFixedWindow = vi.fn();
const runQuestNode = vi.fn();

vi.mock('@bike4mind/database', async importOriginal => {
  // isNodeReady is the REAL one: the scheduler and `computeReadyNodes` must not
  // be allowed to drift, which is the whole reason the tick reuses it. Only the
  // repositories are stubbed.
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    isNodeReady: actual.isNodeReady,
    questGraphRepository: { updateState: (...a: unknown[]) => updateState(...a) },
    questNodeRepository: { updateStatus: (...a: unknown[]) => updateStatus(...a) },
    agentExecutionRepository: { countActiveByUserId: (...a: unknown[]) => countActiveByUserId(...a) },
    cacheRepository: {
      tryIncrementWithinLimitFixedWindow: (...a: unknown[]) => tryIncrementWithinLimitFixedWindow(...a),
    },
  };
});

vi.mock('./runQuestNode', () => ({ runQuestNode: (...a: unknown[]) => runQuestNode(...a) }));

const { advanceGraph } = await import('./advanceGraph');

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const MINUTE = 60_000;

const graph = (over: Partial<IQuestGraphDocument> = {}): IQuestGraphDocument =>
  ({
    id: 'g1',
    userId: 'u1',
    goal: 'ship it',
    sessionId: 's1',
    rootNodeIds: [],
    state: 'active',
    visibility: 'private',
    budget: { maxDepth: 5, maxNodes: 200 },
    ...over,
  }) as IQuestGraphDocument;

const node = (id: string, status: NodeStatus, over: Partial<IQuestNodeDocument> = {}): IQuestNodeDocument =>
  ({
    id,
    graphId: 'g1',
    status,
    dependsOn: [],
    order: 0,
    depth: 0,
    kind: 'task',
    title: id,
    task: 'do it',
    enabledTools: [],
    artifactIds: [],
    ...over,
  }) as IQuestNodeDocument;

const spine = (id: string, status: NodeStatus = 'pending', over: Partial<IQuestNodeDocument> = {}) =>
  node(id, status, { kind: 'spine', ...over });

const run = (over: Partial<{ totalCreditsUsed: number | null }> = {}) =>
  ({ status: 'completed', totalCreditsUsed: null, ...over }) as never;

const advance = (nodes: IQuestNodeDocument[], over: Partial<IQuestGraphDocument> = {}, runs = new Map()) =>
  advanceGraph({ graph: graph(over), nodes, runs, model: 'gpt-5', logger });

beforeEach(() => {
  vi.clearAllMocks();
  updateState.mockResolvedValue(null);
  updateStatus.mockResolvedValue(null);
  countActiveByUserId.mockResolvedValue(0);
  tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true, expiresAt: new Date(0) });
  runQuestNode.mockResolvedValue({ executionId: 'exec-1' });
});

describe('when the graph is not rolling', () => {
  it('does nothing at all', async () => {
    for (const state of ['draft', 'paused', 'completed', 'archived'] as const) {
      const result = await advance([node('a', 'pending')], { state });

      expect(result).toEqual({ dispatched: [], stateChangedTo: null });
    }

    expect(runQuestNode).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('dispatches a ready task', async () => {
    const result = await advance([node('a', 'pending')]);

    expect(result).toEqual({ dispatched: ['a'], stateChangedTo: null });
    expect(runQuestNode).toHaveBeenCalledTimes(1);
    expect(runQuestNode.mock.calls[0][0]).toMatchObject({ userId: 'u1', model: 'gpt-5' });
  });

  // A spine is a phase heading; dispatching one bills a model to restate an
  // objective.
  it('never dispatches a spine', async () => {
    await advance([spine('s1'), node('a', 'completed', { parentId: 's1' })]);

    expect(runQuestNode).not.toHaveBeenCalled();
  });

  it('stops at the per-graph concurrency limit', async () => {
    // MAX_CONCURRENT_EXECUTIONS_PER_USER is 3, so a graph gets 2.
    await advance([node('a', 'pending'), node('b', 'pending'), node('c', 'pending')]);

    expect(runQuestNode).toHaveBeenCalledTimes(2);
  });

  // A lost claim and the per-user cap both land here and are both normal, so the
  // tick stops rather than hammering a full queue.
  it('stops dispatching after the first failure', async () => {
    runQuestNode.mockRejectedValueOnce(new Error('already claimed'));

    const result = await advance([node('a', 'pending'), node('b', 'pending')]);

    expect(result.dispatched).toEqual([]);
    expect(runQuestNode).toHaveBeenCalledTimes(1);
  });

  it('reports only the nodes that actually dispatched', async () => {
    runQuestNode.mockResolvedValueOnce({ executionId: 'e1' }).mockRejectedValueOnce(new Error('cap reached'));

    const result = await advance([node('a', 'pending'), node('b', 'pending')]);

    expect(result.dispatched).toEqual(['a']);
  });
});

// Both of these used to be paid on every 3-second poll.
describe('the dispatch gates', () => {
  // runQuestNode discovers the cap only AFTER an unconditional cleanupStaleActive
  // updateMany. A user at their cap from chat agent mode was paying ~20 of those
  // sweeps a minute for as long as they watched a graph they could not advance.
  it('does not even call the runner when the user is at their execution cap', async () => {
    countActiveByUserId.mockResolvedValue(3);

    const result = await advance([node('a', 'pending')]);

    expect(result).toEqual({ dispatched: [], stateChangedTo: null });
    expect(runQuestNode).not.toHaveBeenCalled();
  });

  it('checks the cap before spending a dispatch budget token', async () => {
    countActiveByUserId.mockResolvedValue(3);

    await advance([node('a', 'pending')]);

    expect(tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  // The tick hangs off a GET with no rateLimit middleware and, being a GET, no
  // CSRF token - so the billable dispatch was reachable at whatever rate the
  // caller polled. This is the manual run route's 20/min, applied per user.
  it('stops dispatching when the rate limit is reached', async () => {
    tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: false, expiresAt: new Date(0) });

    const result = await advance([node('a', 'pending')]);

    expect(result.dispatched).toEqual([]);
    expect(runQuestNode).not.toHaveBeenCalled();
  });

  it('counts one budget token per node, not per tick', async () => {
    await advance([node('a', 'pending'), node('b', 'pending')]);

    expect(tryIncrementWithinLimitFixedWindow).toHaveBeenCalledTimes(2);
    expect(tryIncrementWithinLimitFixedWindow.mock.calls[0][0]).toBe('questmaster-v5-dispatch:u1');
  });

  // The read path has to keep working; the per-user execution cap is still the
  // hard ceiling behind this.
  it('dispatches anyway when the rate-limit store is unavailable', async () => {
    tryIncrementWithinLimitFixedWindow.mockRejectedValue(new Error('cache down'));

    const result = await advance([node('a', 'pending')]);

    expect(result.dispatched).toEqual(['a']);
  });
});

describe('phase roll-up', () => {
  it('completes a spine whose tasks are all terminal', async () => {
    await advance([spine('s1'), node('a', 'completed', { parentId: 's1' })]);

    expect(updateStatus).toHaveBeenCalledWith(
      's1',
      'completed',
      expect.objectContaining({ completedAt: expect.any(Date) })
    );
  });

  // Ordering matters: the roll-up is written first so a phase that just finished
  // reads as done on this very response, and the decision sees it.
  it('writes the roll-up before it decides, so the graph reads as complete now', async () => {
    const result = await advance([spine('s1'), node('a', 'completed', { parentId: 's1' })]);

    expect(result.stateChangedTo).toBe('completed');
    expect(updateStatus).toHaveBeenCalledBefore(updateState as never);
  });

  // Roll-up is presentation, not scheduling. One failed write must not take the
  // dispatch - which has nothing to do with it - down with it.
  it('keeps advancing when a roll-up write fails', async () => {
    updateStatus.mockRejectedValue(new Error('mongo is down'));

    const result = await advance([spine('s1'), node('a', 'completed', { parentId: 's1' }), node('b', 'pending')]);

    expect(result.dispatched).toEqual(['b']);
  });

  // A task depending on the spine is the discriminator: it can only become ready
  // if the spine really did reach `completed`.
  it('unblocks a dependent once the roll-up lands', async () => {
    const result = await advance([
      spine('s1'),
      node('a', 'completed', { parentId: 's1' }),
      node('b', 'pending', { dependsOn: ['s1'] }),
    ]);

    expect(result.dispatched).toEqual(['b']);
  });

  // The decision must never reason off a status the database does not hold. With
  // the write failed, the spine is still `pending`, so its dependent is NOT
  // ready - and the graph must not dispatch it as though it were.
  it('does not tell the decision a failed roll-up succeeded', async () => {
    updateStatus.mockRejectedValue(new Error('mongo is down'));

    const result = await advance([
      spine('s1'),
      node('a', 'completed', { parentId: 's1' }),
      node('b', 'pending', { dependsOn: ['s1'] }),
    ]);

    expect(result.dispatched).toEqual([]);
    expect(runQuestNode).not.toHaveBeenCalled();
    // Stalled rather than silently advancing on a status that was never written.
    expect(result.stateChangedTo).toBe('paused');
  });
});

describe('budgets', () => {
  it('sums credits across every run before deciding', async () => {
    const runs = new Map([
      ['e1', run({ totalCreditsUsed: 60 })],
      ['e2', run({ totalCreditsUsed: 45 })],
    ]);

    const result = await advance(
      [node('a', 'pending')],
      { budget: { maxDepth: 5, maxNodes: 200, maxCredits: 100 } },
      runs
    );

    expect(result.stateChangedTo).toBe('paused');
    expect(runQuestNode).not.toHaveBeenCalled();
  });

  it('treats a run with no recorded credits as zero rather than NaN', async () => {
    const runs = new Map([['e1', run({ totalCreditsUsed: null })]]);

    const result = await advance(
      [node('a', 'pending')],
      { budget: { maxDepth: 5, maxNodes: 200, maxCredits: 100 } },
      runs
    );

    expect(result.dispatched).toEqual(['a']);
  });

  // The finding: `startedAt` spanned every node for all time, so a quest with a
  // manual run from days ago was over budget the instant Run quest was pressed.
  it('ignores a run that predates the current rolling stretch', async () => {
    const now = Date.now();

    const result = await advance(
      [
        // Ran manually an hour before anyone pressed Run quest.
        node('old', 'completed', { startedAt: new Date(now - 60 * MINUTE) }),
        node('a', 'pending'),
      ],
      {
        rollingStartedAt: new Date(now - MINUTE),
        budget: { maxDepth: 5, maxNodes: 200, maxWallClockMs: 10 * MINUTE },
      }
    );

    expect(result.dispatched).toEqual(['a']);
  });

  it('still pauses when this stretch has genuinely overrun', async () => {
    const now = Date.now();

    const result = await advance(
      [node('a', 'pending'), node('b', 'in_progress', { startedAt: new Date(now - 30 * MINUTE) })],
      {
        rollingStartedAt: new Date(now - 40 * MINUTE),
        budget: { maxDepth: 5, maxNodes: 200, maxWallClockMs: 10 * MINUTE },
      }
    );

    expect(result.stateChangedTo).toBe('paused');
  });

  // The second consequence of the old reading: elapsed only ever grew, so a
  // wall-clock pause could never be resumed - the next tick re-paused at once.
  it('lets a wall-clock pause be resumed', async () => {
    const now = Date.now();

    const result = await advance(
      [node('old', 'completed', { startedAt: new Date(now - 60 * MINUTE) }), node('a', 'pending')],
      {
        // Restamped by the resume.
        rollingStartedAt: new Date(now - 1000),
        budget: { maxDepth: 5, maxNodes: 200, maxWallClockMs: 10 * MINUTE },
      }
    );

    expect(result.dispatched).toEqual(['a']);
  });

  // A graph activated before rollingStartedAt existed must keep having its
  // budget enforced, not silently lose it.
  it('falls back to the oldest run when the stretch start is unknown', async () => {
    const result = await advance(
      [node('a', 'pending'), node('b', 'in_progress', { startedAt: new Date(Date.now() - 30 * MINUTE) })],
      { rollingStartedAt: null, budget: { maxDepth: 5, maxNodes: 200, maxWallClockMs: 10 * MINUTE } }
    );

    expect(result.stateChangedTo).toBe('paused');
  });
});

// The decision computed these carefully and then threw them into a server log,
// leaving the user a chip identical to one they paused by hand.
describe('the reason reaches the user', () => {
  it('persists which budget stopped the graph', async () => {
    const runs = new Map([['e1', run({ totalCreditsUsed: 150 })]]);

    await advance([node('a', 'pending')], { budget: { maxDepth: 5, maxNodes: 200, maxCredits: 100 } }, runs);

    expect(updateState).toHaveBeenCalledWith('g1', 'paused', {
      reason: expect.stringContaining('credit budget'),
    });
  });

  it('persists what a stall is waiting on', async () => {
    await advance([node('a', 'failed'), node('b', 'pending', { dependsOn: ['a'] })]);

    expect(updateState).toHaveBeenCalledWith('g1', 'paused', {
      reason: expect.stringContaining('failed dependency'),
    });
  });

  // Wholesale failure is a completion, but it must not read as an unqualified
  // green success.
  it('says so when a completion contains failures', async () => {
    await advance([node('a', 'failed'), node('b', 'completed')]);

    expect(updateState).toHaveBeenCalledWith('g1', 'completed', {
      reason: expect.stringContaining('1 failed task'),
    });
  });

  it('leaves a clean completion unqualified', async () => {
    await advance([node('a', 'completed')]);

    expect(updateState).toHaveBeenCalledWith('g1', 'completed', { reason: null });
  });
});

describe('when the tick itself fails', () => {
  // Contract: a graph read must still return a graph.
  it('leaves the graph unchanged and reports nothing', async () => {
    updateState.mockRejectedValue(new Error('mongo is down'));

    const result = await advance([node('a', 'completed')]);

    expect(result).toEqual({ dispatched: [], stateChangedTo: null });
  });
});
