import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { fromCliTodos, type PlanItem, type PlanItemStatus } from '@bike4mind/common';

export type TodoStatus = PlanItemStatus;

/** Todo items are shared-schema plan items. */
export type TodoItem = PlanItem;

/**
 * Store for managing todo state
 * This is shared across tool invocations
 */
export interface TodoStore {
  /** Current list of todos */
  todos: TodoItem[];
  /** Callback when todos are updated */
  onUpdate?: (todos: TodoItem[]) => void;
}

/**
 * Format todos for display output
 */
function formatTodosOutput(todos: TodoItem[]): string {
  const statusEmoji: Record<TodoStatus, string> = {
    pending: '⬜',
    in_progress: '🔄',
    completed: '✅',
    cancelled: '❌',
  };

  const lines = todos.map((todo, index) => {
    const emoji = statusEmoji[todo.status];
    return `${index + 1}. ${emoji} [${todo.status}] ${todo.content}`;
  });

  return lines.join('\n');
}

/**
 * Create the write_todos tool
 *
 * This tool allows the agent to create and manage a list of subtasks
 * for complex multi-step requests. It provides visibility into the agent's
 * plan and current progress.
 *
 * Key behaviors:
 * - Progress tracking: Updates the list as tasks are completed
 * - Single focus: Only one task can be 'in_progress' at a time
 * - Dynamic updates: The plan may evolve as new information is discovered
 *
 * @param todoStore - Shared store for todo state management
 * @returns Tool definition compatible with agent tools
 */
export function createWriteTodosTool(todoStore: TodoStore): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      const todos = (args as { todos?: unknown } | null)?.todos;
      if (!Array.isArray(todos)) {
        throw new Error('write_todos: todos must be an array');
      }

      const { plan, warnings } = fromCliTodos(todos);
      const notes = warnings.length > 0 ? `\n\nNotes:\n${warnings.map(w => `- ${w}`).join('\n')}` : '';

      // Nothing usable: keep the prior plan rather than wiping it on a malformed write.
      if (todos.length > 0 && plan.items.length === 0) {
        throw new Error(`write_todos: no valid todo items; the existing list was kept.${notes}`);
      }

      todoStore.todos = plan.items;
      todoStore.onUpdate?.(plan.items);

      if (plan.items.length === 0) return 'Todo list cleared.';

      const output = formatTodosOutput(plan.items);

      return `Todo list updated successfully:\n\n${output}${notes}`;
    },
    toolSchema: {
      name: 'write_todos',
      description: `Create or update a list of subtasks for complex multi-step requests.

**When to use this tool:**
- When handling complex requests that require multiple steps
- To break down a large task into smaller, manageable subtasks
- To track progress through a multi-step workflow

**Important guidelines:**
- Call this tool early when receiving complex requests
- Update the list immediately when starting, completing, or cancelling tasks
- Only ONE task should be 'in_progress' at a time (extra ones are reset to pending)
- Never batch updates - update as soon as state changes

**Status values:**
- pending: Task not yet started
- in_progress: Currently working on this task (only ONE allowed)
- completed: Task finished successfully
- cancelled: Task will not be completed

**Example:**
If asked to "create a new React component with tests", break it down:
1. Create component file → in_progress
2. Add component logic → pending
3. Create test file → pending
4. Write unit tests → pending`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              'Complete list of todo items (at most 50). This replaces any existing list. Each item needs content and a status.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'Clear, concise description of the task (imperative, e.g. "Run tests")',
                  maxLength: 200,
                },
                activeForm: {
                  type: 'string',
                  description: 'Present-continuous form shown while in progress (e.g. "Running tests")',
                  maxLength: 200,
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: "Current status of the task. Only ONE task can be 'in_progress' at a time.",
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  };
}

/**
 * Create a new empty TodoStore
 */
export function createTodoStore(onUpdate?: (todos: TodoItem[]) => void): TodoStore {
  return {
    todos: [],
    onUpdate,
  };
}

/** Empty the plan and tell listeners (the Ink plan block) it is gone. */
export function resetTodoStore(store: TodoStore): void {
  store.todos = [];
  store.onUpdate?.([]);
}

/**
 * Get the current in-progress task, if any
 */
export function getCurrentTask(store: TodoStore): TodoItem | undefined {
  return store.todos.find(todo => todo.status === 'in_progress');
}

/**
 * Get summary statistics for the todo list
 */
export function getTodoStats(store: TodoStore): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
} {
  const stats = {
    total: store.todos.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
  };

  for (const todo of store.todos) {
    switch (todo.status) {
      case 'pending':
        stats.pending++;
        break;
      case 'in_progress':
        stats.inProgress++;
        break;
      case 'completed':
        stats.completed++;
        break;
      case 'cancelled':
        stats.cancelled++;
        break;
    }
  }

  return stats;
}
