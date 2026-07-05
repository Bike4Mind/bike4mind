import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

/**
 * Todo item status values
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/**
 * Todo item structure
 */
export interface TodoItem {
  /** Task description */
  description: string;
  /** Current status of the task */
  status: TodoStatus;
}

/**
 * Parameters for the write_todos tool
 */
interface WriteTodosParams {
  /** Complete list of todo items (replaces existing list) */
  todos: TodoItem[];
}

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
 * Valid status values for validation
 */
const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/**
 * Validate todo items
 * @throws Error if validation fails
 */
function validateTodos(todos: unknown): TodoItem[] {
  if (!Array.isArray(todos)) {
    throw new Error('write_todos: todos must be an array');
  }

  if (todos.length === 0) {
    throw new Error('write_todos: todos array cannot be empty');
  }

  // Track in_progress count for validation
  let inProgressCount = 0;

  const validatedTodos: TodoItem[] = todos.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`write_todos: item at index ${index} must be an object`);
    }

    const { description, status } = item as Record<string, unknown>;

    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error(`write_todos: item at index ${index} must have a non-empty description`);
    }

    if (typeof status !== 'string' || !VALID_STATUSES.includes(status as TodoStatus)) {
      throw new Error(
        `write_todos: item at index ${index} has invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`
      );
    }

    if (status === 'in_progress') {
      inProgressCount++;
    }

    return {
      description: description.trim(),
      status: status as TodoStatus,
    };
  });

  // Validate that only one task is in_progress at a time
  if (inProgressCount > 1) {
    throw new Error(`write_todos: only one task can be 'in_progress' at a time, but found ${inProgressCount}`);
  }

  return validatedTodos;
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
    return `${index + 1}. ${emoji} [${todo.status}] ${todo.description}`;
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
      const params = args as WriteTodosParams;

      const validatedTodos = validateTodos(params.todos);

      // Update the store (replaces existing list)
      todoStore.todos = validatedTodos;

      if (todoStore.onUpdate) {
        todoStore.onUpdate(validatedTodos);
      }

      const output = formatTodosOutput(validatedTodos);

      return `Todo list updated successfully:\n\n${output}`;
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
- Only ONE task should be 'in_progress' at a time
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
              'Complete list of todo items. This replaces any existing list. Each item needs a description and status.',
            items: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  description: 'Clear, concise description of the task',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: "Current status of the task. Only ONE task can be 'in_progress' at a time.",
                },
              },
              required: ['description', 'status'],
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
