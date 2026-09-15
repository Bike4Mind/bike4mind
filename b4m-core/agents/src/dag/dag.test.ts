import { describe, it, expect } from 'vitest';
import {
  DecomposeTaskInputSchema,
  validateAndSort,
  findReadyTasks,
  findCascadeDoomed,
  buildPipelineResult,
  type PipelineTaskResult,
} from './index';

describe('DecomposeTaskInputSchema', () => {
  it('accepts a valid decomposition with dependencies', () => {
    const result = DecomposeTaskInputSchema.safeParse({
      tasks: [
        { id: 'explore', description: 'Search codebase', agentType: 'explore' },
        {
          id: 'implement',
          description: 'Write code',
          agentType: 'general-purpose',
          dependsOn: ['explore'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults dependsOn to []', () => {
    const parsed = DecomposeTaskInputSchema.parse({
      tasks: [{ id: 'a', description: 'd', agentType: 'explore' }],
    });
    expect(parsed.tasks[0].dependsOn).toEqual([]);
  });

  it('defaults onFailure to cascade', () => {
    const parsed = DecomposeTaskInputSchema.parse({
      tasks: [{ id: 'a', description: 'd', agentType: 'explore' }],
    });
    expect(parsed.tasks[0].onFailure).toBe('cascade');
  });

  it('accepts onFailure: isolate', () => {
    const parsed = DecomposeTaskInputSchema.parse({
      tasks: [{ id: 'a', description: 'd', agentType: 'explore', onFailure: 'isolate' }],
    });
    expect(parsed.tasks[0].onFailure).toBe('isolate');
  });

  it('rejects empty tasks array', () => {
    expect(DecomposeTaskInputSchema.safeParse({ tasks: [] }).success).toBe(false);
  });

  it('rejects invalid agentType', () => {
    expect(
      DecomposeTaskInputSchema.safeParse({
        tasks: [{ id: 'a', description: 'd', agentType: 'invalid' }],
      }).success
    ).toBe(false);
  });

  it('rejects invalid onFailure', () => {
    expect(
      DecomposeTaskInputSchema.safeParse({
        tasks: [{ id: 'a', description: 'd', agentType: 'explore', onFailure: 'retry' }],
      }).success
    ).toBe(false);
  });
});

describe('validateAndSort', () => {
  it('sorts a linear chain into single-task levels', () => {
    const levels = validateAndSort({
      tasks: [
        { id: 'a', description: 'a', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
        { id: 'b', description: 'b', agentType: 'explore', dependsOn: ['a'], onFailure: 'cascade' },
        { id: 'c', description: 'c', agentType: 'explore', dependsOn: ['b'], onFailure: 'cascade' },
      ],
    });
    expect(levels).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups independent tasks into one level', () => {
    const levels = validateAndSort({
      tasks: [
        { id: 'a', description: 'a', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
        { id: 'b', description: 'b', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
        { id: 'c', description: 'c', agentType: 'explore', dependsOn: ['a', 'b'], onFailure: 'cascade' },
      ],
    });
    expect(levels[0].sort()).toEqual(['a', 'b']);
    expect(levels[1]).toEqual(['c']);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      validateAndSort({
        tasks: [
          { id: 'a', description: 'a', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
          { id: 'a', description: 'a2', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
        ],
      })
    ).toThrow(/Duplicate task id/);
  });

  it('rejects unknown dependency', () => {
    expect(() =>
      validateAndSort({
        tasks: [{ id: 'a', description: 'a', agentType: 'explore', dependsOn: ['ghost'], onFailure: 'cascade' }],
      })
    ).toThrow(/unknown task "ghost"/);
  });

  it('rejects self-dependency', () => {
    expect(() =>
      validateAndSort({
        tasks: [{ id: 'a', description: 'a', agentType: 'explore', dependsOn: ['a'], onFailure: 'cascade' }],
      })
    ).toThrow(/cannot depend on itself/);
  });

  it('rejects circular dependency', () => {
    expect(() =>
      validateAndSort({
        tasks: [
          { id: 'a', description: 'a', agentType: 'explore', dependsOn: ['b'], onFailure: 'cascade' },
          { id: 'b', description: 'b', agentType: 'explore', dependsOn: ['a'], onFailure: 'cascade' },
        ],
      })
    ).toThrow(/Circular dependency/);
  });
});

describe('findReadyTasks', () => {
  const input = {
    tasks: [
      { id: 'root1', description: 'r1', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
      { id: 'root2', description: 'r2', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
      { id: 'mid', description: 'm', agentType: 'explore', dependsOn: ['root1'], onFailure: 'cascade' },
      { id: 'leaf', description: 'l', agentType: 'explore', dependsOn: ['mid', 'root2'], onFailure: 'cascade' },
    ],
  } as const;

  it('returns roots when nothing has completed', () => {
    const ready = findReadyTasks(input, new Set(), new Set(['root1', 'root2', 'mid', 'leaf'])).sort();
    expect(ready).toEqual(['root1', 'root2']);
  });

  it('unblocks mid once root1 completes (root2 still pending and ready)', () => {
    const ready = findReadyTasks(input, new Set(['root1']), new Set(['root2', 'mid', 'leaf'])).sort();
    // root2 has no deps so it's always ready; mid is now unblocked.
    expect(ready).toEqual(['mid', 'root2']);
  });

  it('returns leaf only once both blockers complete', () => {
    // root2 still pending - it's ready, leaf is not (blocked on root2).
    expect(findReadyTasks(input, new Set(['root1', 'mid']), new Set(['root2', 'leaf'])).sort()).toEqual(['root2']);
    // All blockers complete - leaf is finally ready.
    expect(findReadyTasks(input, new Set(['root1', 'root2', 'mid']), new Set(['leaf']))).toEqual(['leaf']);
  });

  it('excludes tasks not in pending set', () => {
    // root1 already running (not pending), so not returned even if eligible.
    expect(findReadyTasks(input, new Set(), new Set(['root2', 'mid', 'leaf']))).toEqual(['root2']);
  });

  it('treats isolated-failed deps as satisfied (onFailure: isolate semantics)', () => {
    // root1 failed with onFailure: isolate. mid depends on root1 - it should
    // be ready to proceed (without root1's result as input).
    const ready = findReadyTasks(
      input,
      new Set(), // nothing completed
      new Set(['mid', 'leaf', 'root2']), // pending
      new Set(['root1']) // root1 failed but isolated
    ).sort();
    // root2 (no deps) is always ready, and mid is now unblocked via isolate.
    expect(ready).toEqual(['mid', 'root2']);
  });

  it('does NOT treat cascade-failed deps as satisfied (default semantics)', () => {
    // root1 failed but no isolatedFailedIds passed (so it's treated as cascade).
    // mid (depends on root1) should NOT be ready.
    const ready = findReadyTasks(input, new Set(), new Set(['mid', 'leaf', 'root2'])).sort();
    expect(ready).toEqual(['root2']); // only root2, mid is blocked.
  });
});

describe('findCascadeDoomed', () => {
  const input = {
    tasks: [
      { id: 'root1', description: 'r1', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
      { id: 'root2', description: 'r2', agentType: 'explore', dependsOn: [], onFailure: 'cascade' },
      { id: 'mid', description: 'm', agentType: 'explore', dependsOn: ['root1'], onFailure: 'cascade' },
      { id: 'leaf', description: 'l', agentType: 'explore', dependsOn: ['mid', 'root2'], onFailure: 'cascade' },
    ],
  } as const;

  it('returns direct dependents of cascade-failed nodes', () => {
    expect(findCascadeDoomed(input, new Set(['mid', 'leaf']), new Set(['root1'])).sort()).toEqual(['mid']);
  });

  it('returns nothing when no cascade-failed nodes', () => {
    expect(findCascadeDoomed(input, new Set(['mid', 'leaf']), new Set())).toEqual([]);
  });

  it('respects pendingIds — excludes already-terminal tasks', () => {
    // mid has root1 (cascade-failed) as dep, but mid isn't pending.
    expect(findCascadeDoomed(input, new Set(['leaf']), new Set(['root1']))).toEqual([]);
  });
});

describe('buildPipelineResult', () => {
  const baseTask: Omit<PipelineTaskResult, 'status' | 'result' | 'error'> = {
    id: 'x',
    description: 'do x',
    agentType: 'explore',
  };

  it('marks success when all completed', () => {
    const result = buildPipelineResult([
      { ...baseTask, id: 'a', status: 'completed', result: 'ok' },
      { ...baseTask, id: 'b', status: 'completed', result: 'ok2' },
    ]);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('Completed Tasks (2/2)');
  });

  it('marks failure when any failed', () => {
    const result = buildPipelineResult([
      { ...baseTask, id: 'a', status: 'completed', result: 'ok' },
      { ...baseTask, id: 'b', status: 'failed', error: 'boom' },
    ]);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('Failed Tasks (1)');
    expect(result.summary).toContain('boom');
  });

  it('includes cascade_failed section', () => {
    const result = buildPipelineResult([
      { ...baseTask, id: 'a', status: 'failed', error: 'boom' },
      { ...baseTask, id: 'b', status: 'cascade_failed', error: 'Blocked by failed dependency "a"' },
    ]);
    expect(result.summary).toContain('Cascade-Failed Tasks (1)');
  });

  it('truncates long results', () => {
    const longResult = 'x'.repeat(2000);
    const result = buildPipelineResult([{ ...baseTask, id: 'a', status: 'completed', result: longResult }], {
      maxResultChars: 100,
    });
    expect(result.summary).toContain('...(truncated)');
    expect(result.summary.length).toBeLessThan(longResult.length);
  });
});
