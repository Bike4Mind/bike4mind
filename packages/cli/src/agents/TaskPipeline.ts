import {
  buildPipelineResult,
  DecomposedTaskSchema,
  DecomposeTaskInputSchema,
  FailurePolicySchema,
  validateAndSort,
  type DecomposedTask,
  type DecomposeTaskInput,
  type FailurePolicy,
  type PipelineExecutionResult,
  type PipelineTask,
  type PipelineTaskResult,
  type PipelineTaskStatus,
} from '@bike4mind/agents';

// Re-export the shared types/schemas so existing CLI imports keep working
// (e.g. `import { DecomposeTaskInputSchema } from './TaskPipeline'`).
export { DecomposedTaskSchema, DecomposeTaskInputSchema, FailurePolicySchema };
export type {
  DecomposedTask,
  DecomposeTaskInput,
  FailurePolicy,
  PipelineTask,
  PipelineTaskResult,
  PipelineTaskStatus,
  PipelineExecutionResult,
};

export type TaskExecutor = (task: DecomposedTask, dependencyResults: Map<string, string>) => Promise<string>;

/**
 * In-process DAG executor for the CLI.
 *
 * Validates the DAG via the shared validator, then runs each level
 * concurrently with `Promise.all`. The web's equivalent dispatches
 * each node to its own Lambda - see `coordinateTask.ts` for that path.
 *
 * Note: this executor honors `cascade` only; an `isolate` task that fails
 * still cascades in the CLI today. The web executor implements both.
 */
export class TaskPipeline {
  private tasks: Map<string, PipelineTask>;
  private executionOrder: string[][];

  constructor(input: DecomposeTaskInput) {
    this.tasks = new Map();
    for (const task of input.tasks) {
      this.tasks.set(task.id, { ...task, status: 'pending' });
    }
    this.executionOrder = validateAndSort(input);
  }

  get size(): number {
    return this.tasks.size;
  }

  getExecutionLevels(): ReadonlyArray<ReadonlyArray<string>> {
    return this.executionOrder;
  }

  isSingleTask(): boolean {
    return this.tasks.size === 1;
  }

  getSingleTask(): DecomposedTask {
    if (!this.isSingleTask()) {
      throw new Error('Pipeline has more than one task');
    }
    return [...this.tasks.values()][0];
  }

  /**
   * Execute all tasks in dependency order.
   * Tasks within the same level run in parallel; failed dependencies
   * cascade to dependents.
   */
  async execute(executor: TaskExecutor): Promise<PipelineExecutionResult> {
    const results = new Map<string, string>();
    const failedTaskIds = new Set<string>();

    for (const level of this.executionOrder) {
      const levelPromises = level.map(async taskId => {
        const task = this.tasks.get(taskId)!;

        const failedDep = task.dependsOn.find(depId => failedTaskIds.has(depId));
        if (failedDep) {
          task.status = 'cascade_failed';
          task.error = `Blocked by failed dependency "${failedDep}"`;
          failedTaskIds.add(taskId);
          return;
        }

        task.status = 'running';

        const depResults = new Map<string, string>();
        for (const depId of task.dependsOn) {
          const depResult = results.get(depId);
          if (depResult) {
            depResults.set(depId, depResult);
          }
        }

        try {
          const result = await executor(task, depResults);
          task.status = 'completed';
          task.result = result;
          results.set(taskId, result);
        } catch (error) {
          task.status = 'failed';
          task.error = error instanceof Error ? error.message : String(error);
          failedTaskIds.add(taskId);
        }
      });

      await Promise.all(levelPromises);
    }

    return buildPipelineResult(
      [...this.tasks.values()].map(t => ({
        id: t.id,
        description: t.description,
        agentType: t.agentType,
        status: t.status,
        result: t.result,
        error: t.error,
      }))
    );
  }
}

// ============================================================================
// Builder API
// ============================================================================

export interface TaskBuilderOptions {
  agent: string;
  prompt: string;
  dependsOn?: string[];
  onFailure?: FailurePolicy;
}

const VALID_AGENT_TYPES: ReadonlySet<string> = new Set(['explore', 'plan', 'general-purpose', 'review', 'test']);

/**
 * Declarative builder for constructing TaskPipeline instances.
 */
export class TaskPipelineBuilder {
  private taskDefs: Array<{ id: string; options: TaskBuilderOptions }> = [];

  task(id: string, options: TaskBuilderOptions): this {
    this.taskDefs.push({ id, options });
    return this;
  }

  build(): TaskPipeline {
    const tasks: DecomposeTaskInput['tasks'] = this.taskDefs.map(({ id, options }) => ({
      id,
      description: options.prompt,
      agentType: this.resolveAgentType(options.agent),
      dependsOn: options.dependsOn ?? [],
      onFailure: options.onFailure ?? 'cascade',
    }));

    return new TaskPipeline({ tasks });
  }

  getTaskDefinitions(): ReadonlyArray<{ id: string; options: TaskBuilderOptions }> {
    return this.taskDefs;
  }

  private resolveAgentType(agent: string): DecomposedTask['agentType'] {
    if (VALID_AGENT_TYPES.has(agent)) {
      return agent as DecomposedTask['agentType'];
    }
    console.debug(`[TaskPipelineBuilder] Unknown agent type "${agent}", falling back to general-purpose`);
    return 'general-purpose';
  }
}
