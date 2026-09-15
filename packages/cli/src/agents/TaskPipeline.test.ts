import { describe, it, expect } from 'vitest';
import {
  TaskPipeline,
  TaskPipelineBuilder,
  DecomposeTaskInputSchema,
  type DecomposeTaskInput,
  type TaskExecutor,
} from './TaskPipeline';

describe('DecomposeTaskInputSchema', () => {
  it('should validate a valid decomposition', () => {
    const input = {
      tasks: [
        { id: 'explore', description: 'Search codebase', agentType: 'explore' },
        { id: 'implement', description: 'Write code', agentType: 'general-purpose', dependsOn: ['explore'] },
      ],
    };

    const result = DecomposeTaskInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('should default dependsOn to empty array', () => {
    const input = {
      tasks: [{ id: 'task1', description: 'A task', agentType: 'explore' }],
    };

    const result = DecomposeTaskInputSchema.parse(input);
    expect(result.tasks[0].dependsOn).toEqual([]);
  });

  it('should reject empty tasks array', () => {
    const input = { tasks: [] };
    const result = DecomposeTaskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject invalid agent types', () => {
    const input = {
      tasks: [{ id: 'task1', description: 'A task', agentType: 'invalid-agent' }],
    };
    const result = DecomposeTaskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('should reject tasks with empty id', () => {
    const input = {
      tasks: [{ id: '', description: 'A task', agentType: 'explore' }],
    };
    const result = DecomposeTaskInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('TaskPipeline', () => {
  // Tests pass DecomposedTask-shaped objects without explicit `onFailure`.
  // The schema defaults it to 'cascade', so fill it in here to keep test
  // literals concise while satisfying the post-parse type.
  type TestInputTask = Omit<DecomposeTaskInput['tasks'][number], 'onFailure'> & {
    onFailure?: DecomposeTaskInput['tasks'][number]['onFailure'];
  };
  const makeInput = (tasks: TestInputTask[]): DecomposeTaskInput => ({
    tasks: tasks.map(t => ({ ...t, onFailure: t.onFailure ?? 'cascade' })),
  });

  describe('constructor validation', () => {
    it('should create pipeline from valid input', () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'Task A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'Task B', agentType: 'general-purpose', dependsOn: ['a'] },
        ])
      );

      expect(pipeline.size).toBe(2);
    });

    it('should throw on unknown dependency reference', () => {
      expect(() => {
        new TaskPipeline(
          makeInput([{ id: 'a', description: 'Task A', agentType: 'explore', dependsOn: ['nonexistent'] }])
        );
      }).toThrow('depends on unknown task "nonexistent"');
    });

    it('should throw on self-dependency', () => {
      expect(() => {
        new TaskPipeline(makeInput([{ id: 'a', description: 'Task A', agentType: 'explore', dependsOn: ['a'] }]));
      }).toThrow('cannot depend on itself');
    });

    it('should throw on circular dependency (direct)', () => {
      expect(() => {
        new TaskPipeline(
          makeInput([
            { id: 'a', description: 'Task A', agentType: 'explore', dependsOn: ['b'] },
            { id: 'b', description: 'Task B', agentType: 'explore', dependsOn: ['a'] },
          ])
        );
      }).toThrow(/[Cc]ircular dependency/);
    });

    it('should throw on circular dependency (indirect)', () => {
      expect(() => {
        new TaskPipeline(
          makeInput([
            { id: 'a', description: 'A', agentType: 'explore', dependsOn: ['c'] },
            { id: 'b', description: 'B', agentType: 'explore', dependsOn: ['a'] },
            { id: 'c', description: 'C', agentType: 'explore', dependsOn: ['b'] },
          ])
        );
      }).toThrow(/[Cc]ircular dependency/);
    });
  });

  describe('isSingleTask', () => {
    it('should return true for single task', () => {
      const pipeline = new TaskPipeline(
        makeInput([{ id: 'only', description: 'Only task', agentType: 'explore', dependsOn: [] }])
      );

      expect(pipeline.isSingleTask()).toBe(true);
    });

    it('should return false for multiple tasks', () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'explore', dependsOn: [] },
        ])
      );

      expect(pipeline.isSingleTask()).toBe(false);
    });
  });

  describe('getSingleTask', () => {
    it('should return the single task', () => {
      const pipeline = new TaskPipeline(
        makeInput([{ id: 'only', description: 'Only task', agentType: 'review', dependsOn: [] }])
      );

      const task = pipeline.getSingleTask();
      expect(task.id).toBe('only');
      expect(task.agentType).toBe('review');
    });

    it('should throw when pipeline has multiple tasks', () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'explore', dependsOn: [] },
        ])
      );

      expect(() => pipeline.getSingleTask()).toThrow('more than one task');
    });
  });

  describe('getExecutionLevels', () => {
    it('should group independent tasks into same level', () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'explore', dependsOn: [] },
          { id: 'c', description: 'C', agentType: 'general-purpose', dependsOn: ['a', 'b'] },
        ])
      );

      const levels = pipeline.getExecutionLevels();
      expect(levels.length).toBe(2);
      expect(levels[0]).toContain('a');
      expect(levels[0]).toContain('b');
      expect(levels[1]).toEqual(['c']);
    });

    it('should create sequential levels for linear dependencies', () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'plan', dependsOn: ['a'] },
          { id: 'c', description: 'C', agentType: 'general-purpose', dependsOn: ['b'] },
        ])
      );

      const levels = pipeline.getExecutionLevels();
      expect(levels.length).toBe(3);
      expect(levels[0]).toEqual(['a']);
      expect(levels[1]).toEqual(['b']);
      expect(levels[2]).toEqual(['c']);
    });

    it('should handle diamond dependencies', () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'root', description: 'Root', agentType: 'explore', dependsOn: [] },
          { id: 'left', description: 'Left', agentType: 'explore', dependsOn: ['root'] },
          { id: 'right', description: 'Right', agentType: 'explore', dependsOn: ['root'] },
          { id: 'merge', description: 'Merge', agentType: 'general-purpose', dependsOn: ['left', 'right'] },
        ])
      );

      const levels = pipeline.getExecutionLevels();
      expect(levels.length).toBe(3);
      expect(levels[0]).toEqual(['root']);
      expect(levels[1]).toContain('left');
      expect(levels[1]).toContain('right');
      expect(levels[2]).toEqual(['merge']);
    });
  });

  describe('execute', () => {
    it('should execute tasks in dependency order', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'general-purpose', dependsOn: ['a'] },
        ])
      );

      const executionOrder: string[] = [];
      const executor: TaskExecutor = async task => {
        executionOrder.push(task.id);
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(['a', 'b']);
      expect(result.taskResults).toHaveLength(2);
    });

    it('should execute independent tasks in parallel', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'explore', dependsOn: [] },
          { id: 'c', description: 'C', agentType: 'general-purpose', dependsOn: ['a', 'b'] },
        ])
      );

      const startTimes: Record<string, number> = {};
      const executor: TaskExecutor = async task => {
        startTimes[task.id] = Date.now();
        // Small delay to test parallelism
        await new Promise(resolve => setTimeout(resolve, 10));
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.success).toBe(true);
      // a and b should start at roughly the same time (both in level 0)
      expect(Math.abs(startTimes['a'] - startTimes['b'])).toBeLessThan(50);
      // c should start after a and b
      expect(startTimes['c']).toBeGreaterThan(startTimes['a']);
    });

    it('should pass dependency results to downstream tasks', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'general-purpose', dependsOn: ['a'] },
        ])
      );

      const receivedDeps: Map<string, Map<string, string>> = new Map();
      const executor: TaskExecutor = async (task, depResults) => {
        receivedDeps.set(task.id, new Map(depResults));
        return `Result of ${task.id}`;
      };

      await pipeline.execute(executor);

      expect(receivedDeps.get('a')!.size).toBe(0);
      expect(receivedDeps.get('b')!.get('a')).toBe('Result of a');
    });

    it('should cascade failure to direct dependents', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'general-purpose', dependsOn: ['a'] },
        ])
      );

      const executor: TaskExecutor = async task => {
        if (task.id === 'a') throw new Error('Task A failed');
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.success).toBe(false);
      expect(result.taskResults.find(t => t.id === 'a')?.status).toBe('failed');
      expect(result.taskResults.find(t => t.id === 'a')?.error).toBe('Task A failed');
      expect(result.taskResults.find(t => t.id === 'b')?.status).toBe('cascade_failed');
      expect(result.taskResults.find(t => t.id === 'b')?.error).toContain('Blocked by failed dependency "a"');
    });

    it('should cascade failure transitively through the graph', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'plan', dependsOn: ['a'] },
          { id: 'c', description: 'C', agentType: 'general-purpose', dependsOn: ['b'] },
          { id: 'd', description: 'D', agentType: 'review', dependsOn: ['c'] },
        ])
      );

      const executor: TaskExecutor = async task => {
        if (task.id === 'a') throw new Error('Root failure');
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.success).toBe(false);
      expect(result.taskResults.find(t => t.id === 'a')?.status).toBe('failed');
      expect(result.taskResults.find(t => t.id === 'b')?.status).toBe('cascade_failed');
      expect(result.taskResults.find(t => t.id === 'c')?.status).toBe('cascade_failed');
      expect(result.taskResults.find(t => t.id === 'd')?.status).toBe('cascade_failed');
    });

    it('should only cascade to dependent branches, not independent tasks', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'explore', dependsOn: [] },
          { id: 'c', description: 'C', agentType: 'general-purpose', dependsOn: ['a'] },
          { id: 'd', description: 'D', agentType: 'general-purpose', dependsOn: ['b'] },
        ])
      );

      const executor: TaskExecutor = async task => {
        if (task.id === 'a') throw new Error('A failed');
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.success).toBe(false);
      expect(result.taskResults.find(t => t.id === 'a')?.status).toBe('failed');
      expect(result.taskResults.find(t => t.id === 'b')?.status).toBe('completed');
      expect(result.taskResults.find(t => t.id === 'c')?.status).toBe('cascade_failed');
      expect(result.taskResults.find(t => t.id === 'd')?.status).toBe('completed');
    });

    it('should report success when all tasks complete', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'review', dependsOn: ['a'] },
        ])
      );

      const executor: TaskExecutor = async task => `Done: ${task.id}`;
      const result = await pipeline.execute(executor);

      expect(result.success).toBe(true);
      expect(result.taskResults.every(t => t.status === 'completed')).toBe(true);
      expect(result.summary).toContain('Completed Tasks');
    });

    it('should cascade correctly through diamond dependencies', async () => {
      // Diamond: A->B, A->C, B->D, C->D. A fails -> B,C,D all cascade-failed
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'plan', dependsOn: ['a'] },
          { id: 'c', description: 'C', agentType: 'plan', dependsOn: ['a'] },
          { id: 'd', description: 'D', agentType: 'general-purpose', dependsOn: ['b', 'c'] },
        ])
      );

      const executor: TaskExecutor = async task => {
        if (task.id === 'a') throw new Error('Diamond root failed');
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.success).toBe(false);
      expect(result.taskResults.find(t => t.id === 'a')?.status).toBe('failed');
      expect(result.taskResults.find(t => t.id === 'b')?.status).toBe('cascade_failed');
      expect(result.taskResults.find(t => t.id === 'c')?.status).toBe('cascade_failed');
      expect(result.taskResults.find(t => t.id === 'd')?.status).toBe('cascade_failed');
    });

    it('should cascade when one branch of diamond fails and other succeeds', async () => {
      // A and B are independent. C depends on both. B fails -> C cascade-failed.
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'explore', dependsOn: [] },
          { id: 'c', description: 'C', agentType: 'general-purpose', dependsOn: ['a', 'b'] },
        ])
      );

      const executor: TaskExecutor = async task => {
        if (task.id === 'b') throw new Error('B failed');
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);

      expect(result.taskResults.find(t => t.id === 'a')?.status).toBe('completed');
      expect(result.taskResults.find(t => t.id === 'b')?.status).toBe('failed');
      expect(result.taskResults.find(t => t.id === 'c')?.status).toBe('cascade_failed');
    });

    it('should include cascade-failed in summary', async () => {
      const pipeline = new TaskPipeline(
        makeInput([
          { id: 'a', description: 'A', agentType: 'explore', dependsOn: [] },
          { id: 'b', description: 'B', agentType: 'plan', dependsOn: ['a'] },
        ])
      );

      const executor: TaskExecutor = async task => {
        if (task.id === 'a') throw new Error('Boom');
        return `Result of ${task.id}`;
      };

      const result = await pipeline.execute(executor);
      expect(result.summary).toContain('Cascade-Failed Tasks');
    });
  });
});

describe('TaskPipelineBuilder', () => {
  it('should build a pipeline from chained .task() calls', () => {
    const pipeline = new TaskPipelineBuilder()
      .task('explore', { agent: 'explore', prompt: 'Find auth files' })
      .task('plan', { agent: 'plan', prompt: 'Plan refactor', dependsOn: ['explore'] })
      .task('implement', { agent: 'general-purpose', prompt: 'Implement changes', dependsOn: ['plan'] })
      .build();

    expect(pipeline.size).toBe(3);
    const levels = pipeline.getExecutionLevels();
    expect(levels).toHaveLength(3);
    expect(levels[0]).toEqual(['explore']);
    expect(levels[1]).toEqual(['plan']);
    expect(levels[2]).toEqual(['implement']);
  });

  it('should support parallel tasks with no dependencies', () => {
    const pipeline = new TaskPipelineBuilder()
      .task('explore-auth', { agent: 'explore', prompt: 'Explore auth' })
      .task('explore-db', { agent: 'explore', prompt: 'Explore db' })
      .task('plan', { agent: 'plan', prompt: 'Plan', dependsOn: ['explore-auth', 'explore-db'] })
      .build();

    const levels = pipeline.getExecutionLevels();
    expect(levels).toHaveLength(2);
    expect(levels[0]).toContain('explore-auth');
    expect(levels[0]).toContain('explore-db');
    expect(levels[1]).toEqual(['plan']);
  });

  it('should fall back to general-purpose for unknown agent types', () => {
    const builder = new TaskPipelineBuilder().task('custom', { agent: 'my-custom-agent', prompt: 'Do something' });

    const defs = builder.getTaskDefinitions();
    const pipeline = builder.build();
    expect(defs[0].options.agent).toBe('my-custom-agent');
    // The pipeline resolves unknown types to general-purpose
    expect(pipeline.size).toBe(1);
  });

  it('should execute a built pipeline correctly', async () => {
    const pipeline = new TaskPipelineBuilder()
      .task('explore', { agent: 'explore', prompt: 'Explore codebase' })
      .task('implement', { agent: 'general-purpose', prompt: 'Implement', dependsOn: ['explore'] })
      .build();

    const executionOrder: string[] = [];
    const executor: TaskExecutor = async task => {
      executionOrder.push(task.id);
      return `Done: ${task.id}`;
    };

    const result = await pipeline.execute(executor);

    expect(result.success).toBe(true);
    expect(executionOrder).toEqual(['explore', 'implement']);
  });

  it('should throw on circular dependencies in built pipeline', () => {
    expect(() => {
      new TaskPipelineBuilder()
        .task('a', { agent: 'explore', prompt: 'A', dependsOn: ['b'] })
        .task('b', { agent: 'explore', prompt: 'B', dependsOn: ['a'] })
        .build();
    }).toThrow(/[Cc]ircular dependency/);
  });
});
