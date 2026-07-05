import type { DecomposeTaskInput, DecomposedTask } from './schemas';

/**
 * Validate the task graph and return the topological execution levels.
 *
 * - All dependency references must point to existing tasks
 * - No task can depend on itself
 * - No circular dependencies
 * - No duplicate task ids
 *
 * Throws on any violation. Returns levels (each level's tasks have no
 * inter-dependencies and can run concurrently).
 */
export function validateAndSort(input: DecomposeTaskInput): string[][] {
  const tasks = new Map<string, DecomposedTask>();
  for (const task of input.tasks) {
    if (tasks.has(task.id)) {
      throw new Error(`Duplicate task id: "${task.id}"`);
    }
    tasks.set(task.id, task);
  }

  for (const [taskId, task] of tasks) {
    for (const depId of task.dependsOn) {
      if (!tasks.has(depId)) {
        throw new Error(`Task "${taskId}" depends on unknown task "${depId}"`);
      }
      if (depId === taskId) {
        throw new Error(`Task "${taskId}" cannot depend on itself`);
      }
    }
  }

  detectCycles(tasks);
  return topologicalSort(tasks);
}

function detectCycles(tasks: Map<string, DecomposedTask>): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  for (const taskId of tasks.keys()) {
    if (visited.has(taskId)) continue;

    const stack: Array<{ id: string; phase: 'enter' | 'exit' }> = [{ id: taskId, phase: 'enter' }];

    while (stack.length > 0) {
      const { id, phase } = stack.pop()!;

      if (phase === 'exit') {
        inStack.delete(id);
        continue;
      }

      if (inStack.has(id)) {
        throw new Error(`Circular dependency detected involving task "${id}"`);
      }

      if (visited.has(id)) continue;

      visited.add(id);
      inStack.add(id);
      stack.push({ id, phase: 'exit' });

      const task = tasks.get(id)!;
      for (const depId of task.dependsOn) {
        if (inStack.has(depId)) {
          throw new Error(`Circular dependency detected: "${id}" → "${depId}"`);
        }
        if (!visited.has(depId)) {
          stack.push({ id: depId, phase: 'enter' });
        }
      }
    }
  }
}

/**
 * Kahn's algorithm - group tasks into execution levels.
 * Tasks within a level have no inter-dependencies.
 */
function topologicalSort(tasks: Map<string, DecomposedTask>): string[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const [taskId, task] of tasks) {
    inDegree.set(taskId, task.dependsOn.length);
    for (const depId of task.dependsOn) {
      const deps = dependents.get(depId) || [];
      deps.push(taskId);
      dependents.set(depId, deps);
    }
  }

  const levels: string[][] = [];
  let currentLevel = [...tasks.keys()].filter(id => inDegree.get(id) === 0);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);

    const nextLevel: string[] = [];
    for (const taskId of currentLevel) {
      for (const dependent of dependents.get(taskId) || []) {
        const newDegree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextLevel.push(dependent);
        }
      }
    }

    currentLevel = nextLevel;
  }

  return levels;
}

/**
 * Given partial sets of completed and isolated-failed task ids, return the
 * ids of pending tasks whose dependencies are all "satisfied":
 *
 *   - `completedIds`: nodes whose work finished successfully.
 *   - `isolatedFailedIds`: nodes that failed/aborted AND had `onFailure: 'isolate'`.
 *     Their dependents should proceed (without that node's result as input)
 *     because the policy says "don't poison the rest of the DAG."
 *
 * Cascade-failed deps are NOT in either set, so dependents of a cascade-failed
 * node stay non-ready and will eventually be marked terminal-failed by the
 * cascade sweep in the completion handler.
 */
export function findReadyTasks(
  input: DecomposeTaskInput,
  completedIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
  isolatedFailedIds: ReadonlySet<string> = new Set()
): string[] {
  const ready: string[] = [];
  for (const task of input.tasks) {
    if (!pendingIds.has(task.id)) continue;
    if (task.dependsOn.every(d => completedIds.has(d) || isolatedFailedIds.has(d))) {
      ready.push(task.id);
    }
  }
  return ready;
}

/**
 * Find pending tasks that are doomed by an upstream cascade-failed dep -
 * i.e., any pending task whose `dependsOn` graph (transitively) contains a
 * `cascadeFailedIds` member AND that path isn't bypassed by an isolated-failed
 * fork.
 *
 * Used by the completion handler to explicitly mark these terminal so the
 * DAG can finish; otherwise they'd sit `pending` forever and the parent
 * resume would never fire.
 *
 * The simplified algorithm: a pending node is doomed if ANY of its direct
 * deps is in `cascadeFailedIds`, OR if any of its direct deps is itself
 * already doomed (transitive closure via successive sweeps in the caller).
 * The caller invokes this iteratively after each completion until the set
 * stabilises.
 */
export function findCascadeDoomed(
  input: DecomposeTaskInput,
  pendingIds: ReadonlySet<string>,
  cascadeFailedIds: ReadonlySet<string>
): string[] {
  const doomed: string[] = [];
  for (const task of input.tasks) {
    if (!pendingIds.has(task.id)) continue;
    if (task.dependsOn.some(d => cascadeFailedIds.has(d))) {
      doomed.push(task.id);
    }
  }
  return doomed;
}
