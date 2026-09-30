import type { ChatMessage } from './chat';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export const TODO_TOOL_NAME = 'todo_write';
export const MAX_TODOS = 50;
export const MAX_TODO_CHARS = 200;

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * The plan a `todo_write` call carries, or why it is not one.
 *
 * Shared by the tool, which refuses a bad list so the model corrects it, and by the renderer,
 * which draws the plan from the call's own input: the transcript is the only store, so a plan
 * survives a restart and a window opened mid-turn with nothing persisted beside it.
 */
export function parseTodos(value: unknown): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'The "todos" argument is required and must be an array.' };
  if (value.length > MAX_TODOS) return { error: `At most ${MAX_TODOS} todos are allowed; merge or drop some.` };

  const todos: TodoItem[] = [];
  for (const [index, entry] of value.entries()) {
    const item = entry as { content?: unknown; status?: unknown } | null;
    const label = `Todo ${index + 1}`;
    if (typeof item !== 'object' || item === null) return { error: `${label} must be an object.` };
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) return { error: `${label} needs non-empty "content".` };
    if (content.length > MAX_TODO_CHARS) return { error: `${label} is over ${MAX_TODO_CHARS} characters; shorten it.` };
    if (!STATUSES.includes(item.status as TodoStatus)) {
      return { error: `${label} has status ${JSON.stringify(item.status)}; use ${STATUSES.join(', ')}.` };
    }
    todos.push({ content, status: item.status as TodoStatus });
  }
  return { todos };
}

/** The most recent plan in a thread: the list the last accepted `todo_write` set, or null if none. */
export function latestTodos(messages: readonly ChatMessage[]): TodoItem[] | null {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const calls = messages[m].toolCalls ?? [];
    for (let c = calls.length - 1; c >= 0; c -= 1) {
      const call = calls[c];
      if (call.name !== TODO_TOOL_NAME || call.status === 'error' || call.status === 'denied') continue;
      const parsed = parseTodos(call.input.todos);
      if ('todos' in parsed) return parsed.todos;
    }
  }
  return null;
}

export function countTodos(todos: readonly TodoItem[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}
