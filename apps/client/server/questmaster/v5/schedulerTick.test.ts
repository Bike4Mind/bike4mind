import { describe, expect, it } from 'vitest';
import { planSchedulerTick, spineNodesToComplete, type SchedulableNode } from './schedulerTick';

const task = (id: string, status = 'pending', dependsOn: string[] = []): SchedulableNode =>
  ({ id, status, dependsOn, kind: 'task' }) as SchedulableNode;
const spine = (id: string, status = 'pending'): SchedulableNode =>
  ({ id, status, dependsOn: [], kind: 'spine' }) as SchedulableNode;

const tick = (nodes: SchedulableNode[], over: Partial<Parameters<typeof planSchedulerTick>[0]> = {}) =>
  planSchedulerTick({
    state: 'active',
    nodes,
    budget: {},
    creditsUsed: 0,
    elapsedMs: null,
    maxConcurrent: 2,
    ...over,
  });

describe('planSchedulerTick', () => {
  it('dispatches the ready tasks', () => {
    expect(tick([task('a'), task('b')])).toEqual({ action: 'dispatch', nodeIds: ['a', 'b'] });
  });

  it('does nothing unless the graph is active', () => {
    for (const state of ['draft', 'paused', 'completed', 'archived'] as const) {
      expect(tick([task('a')], { state })).toMatchObject({ action: 'idle' });
    }
  });

  // A spine is a phase heading, not work. Dispatching one would bill a model to
  // restate an objective.
  it('never dispatches a spine node', () => {
    expect(tick([spine('s1'), task('a', 'pending')])).toEqual({ action: 'dispatch', nodeIds: ['a'] });
  });

  it('respects the concurrency limit', () => {
    const decision = tick([task('a', 'in_progress'), task('b'), task('c')], { maxConcurrent: 2 });
    expect(decision).toEqual({ action: 'dispatch', nodeIds: ['b'] });
  });

  it('idles at the concurrency limit rather than queueing more', () => {
    expect(tick([task('a', 'in_progress'), task('b', 'in_progress'), task('c')], { maxConcurrent: 2 })).toMatchObject({
      action: 'idle',
    });
  });

  it('waits while work is running and nothing else is ready', () => {
    expect(tick([task('a', 'in_progress'), task('b', 'pending', ['a'])])).toMatchObject({ action: 'idle' });
  });

  it('holds a task whose dependency is unfinished', () => {
    expect(tick([task('a', 'in_progress'), task('b', 'pending', ['a'])])).not.toMatchObject({ action: 'dispatch' });
  });

  it('releases a task once its dependency completes', () => {
    expect(tick([task('a', 'completed'), task('b', 'pending', ['a'])])).toEqual({
      action: 'dispatch',
      nodeIds: ['b'],
    });
  });

  it('completes when every task is terminal', () => {
    expect(tick([task('a', 'completed'), task('b', 'skipped'), task('c', 'failed')])).toEqual({
      action: 'complete',
      failedCount: 1,
    });
  });

  // A spine sitting at `pending` must not make a finished graph look unfinished.
  it('completes even though spine nodes are not terminal', () => {
    expect(tick([spine('s1'), task('a', 'completed')])).toEqual({ action: 'complete', failedCount: 0 });
  });

  // `failed` is terminal, so a graph whose every task failed IS finished - but
  // reporting it as a plain completion made the view render a green chip over
  // wholesale failure. The count travels on the decision so the caller can say
  // so, rather than re-deriving it and drifting.
  it('reports how many tasks failed in a completion', () => {
    expect(tick([task('a', 'failed'), task('b', 'failed')])).toEqual({ action: 'complete', failedCount: 2 });
    expect(tick([task('a', 'completed')])).toEqual({ action: 'complete', failedCount: 0 });
  });

  // The stall case: a failed dependency means the dependent can never become
  // ready. Idling forever would just look slow; pausing says what happened.
  it('pauses when unfinished work can never become ready', () => {
    const decision = tick([task('a', 'failed'), task('b', 'pending', ['a'])]);
    expect(decision).toMatchObject({ action: 'pause' });
    expect((decision as { reason: string }).reason).toContain('failed dependency');
  });

  // The reason has to name the actual blocker. "Check for a failed dependency"
  // was the only explanation on offer, which sent the reader hunting for a
  // failure that had not happened.
  it('names a missing dependency rather than blaming a failure', () => {
    const decision = tick([task('b', 'pending', ['gone'])]);
    expect(decision).toMatchObject({ action: 'pause' });
    const { reason } = decision as { reason: string };
    expect(reason).toContain('no longer exists');
    expect(reason).not.toContain('failed');
  });

  describe('budgets', () => {
    it('pauses once the credit budget is spent', () => {
      const decision = tick([task('a')], { budget: { maxCredits: 100 }, creditsUsed: 100 });
      expect(decision).toMatchObject({ action: 'pause' });
      expect((decision as { reason: string }).reason).toContain('credit budget');
    });

    it('pauses once the wall-clock budget elapses', () => {
      expect(tick([task('a')], { budget: { maxWallClockMs: 1000 }, elapsedMs: 1000 })).toMatchObject({
        action: 'pause',
      });
    });

    // Checked BEFORE dispatch, so an overspent graph cannot sneak one more
    // billable run out on its way to being paused.
    it('does not dispatch on the tick that finds the budget spent', () => {
      expect(tick([task('a'), task('b')], { budget: { maxCredits: 10 }, creditsUsed: 10 })).not.toMatchObject({
        action: 'dispatch',
      });
    });

    it('keeps going while inside budget', () => {
      expect(tick([task('a')], { budget: { maxCredits: 100 }, creditsUsed: 99 })).toMatchObject({
        action: 'dispatch',
      });
    });

    it('ignores an unset budget', () => {
      expect(tick([task('a')], { creditsUsed: 1e9, elapsedMs: 1e9 })).toMatchObject({ action: 'dispatch' });
    });
  });
});

describe('overlapping ticks', () => {
  // The per-graph limit is a guide rail, not a lock: in-flight is read from the
  // graph as it stands, so two overlapping polls can see the same free slots.
  // Pinned as KNOWN behaviour - `claimForRun` still gives one dispatch per node
  // and the per-user cap is the ceiling that actually holds.
  it('two ticks against the same unchanged graph both dispatch', () => {
    const nodes = [task('a'), task('b')];
    expect(tick(nodes)).toEqual({ action: 'dispatch', nodeIds: ['a', 'b'] });
    expect(tick(nodes)).toEqual({ action: 'dispatch', nodeIds: ['a', 'b'] });
  });

  it('stops dispatching once the graph reflects the work', () => {
    expect(tick([task('a', 'in_progress'), task('b', 'in_progress')], { maxConcurrent: 2 })).toMatchObject({
      action: 'idle',
    });
  });
});

describe('spineNodesToComplete', () => {
  const withParent = (id: string, status: string, parentId: string) =>
    ({ id, status, dependsOn: [], kind: 'task', parentId }) as SchedulableNode & { parentId: string };

  it('completes a spine once all of its tasks are terminal', () => {
    const nodes = [spine('s1'), withParent('a', 'completed', 's1'), withParent('b', 'failed', 's1')];
    expect(spineNodesToComplete(nodes)).toEqual(['s1']);
  });

  it('leaves a spine alone while any of its tasks is unfinished', () => {
    const nodes = [spine('s1'), withParent('a', 'completed', 's1'), withParent('b', 'in_progress', 's1')];
    expect(spineNodesToComplete(nodes)).toEqual([]);
  });

  // A childless spine has no work to wait for, so it counts as finished. Leaving
  // it `pending` made it a permanent blocker: isNodeReady requires every
  // dependency to be completed or skipped, so a task depending on one could
  // never become ready and the graph paused citing a failure that never happened.
  it('completes a childless spine - it has no work to wait for', () => {
    expect(spineNodesToComplete([spine('s1')])).toEqual(['s1']);
  });

  it('unblocks a task that depends on a childless spine', () => {
    // Before: 's1' stayed pending, 'a' could never be ready, and the graph
    // paused blaming a failed dependency.
    const rolled = spineNodesToComplete([spine('s1'), task('a', 'pending', ['s1'])]);
    expect(rolled).toEqual(['s1']);
  });

  it('does not re-complete a spine that is already terminal', () => {
    const nodes = [spine('s1', 'completed'), withParent('a', 'completed', 's1')];
    expect(spineNodesToComplete(nodes)).toEqual([]);
  });

  it('handles several phases independently', () => {
    const nodes = [spine('s1'), withParent('a', 'completed', 's1'), spine('s2'), withParent('b', 'pending', 's2')];
    expect(spineNodesToComplete(nodes)).toEqual(['s1']);
  });
});
