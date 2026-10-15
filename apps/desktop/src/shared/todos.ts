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

/**
 * The plan for the work in hand, or null when nothing current is being worked to.
 *
 * `latestTodos` reaches back through the whole thread, which is right for reading a history but
 * wrong for deciding what to SHOW: a plan the model wrote, drifted away from and never cleared
 * would sit above the composer for the rest of the conversation, describing work nobody is doing.
 * A plan is current only while the model is still writing it, so the window is the newest
 * assistant reply - plus, while a turn is open, the one before it, which is what carries a plan
 * from the turn that wrote it into the turn that works through it.
 *
 * So a user message whose reply never touches the plan drops it: the reply in flight has none,
 * the previous one does and holds it up while the turn runs, and the turn ending closes the
 * window to the reply itself.
 */
export function activeTodos(messages: readonly ChatMessage[], turnOpen: boolean): TodoItem[] | null {
  const window = turnOpen ? 2 : 1;
  const recent: ChatMessage[] = [];
  for (let m = messages.length - 1; m >= 0 && recent.length < window; m -= 1) {
    if (messages[m].role === 'assistant') recent.unshift(messages[m]);
  }
  return latestTodos(recent);
}

export function countTodos(todos: readonly TodoItem[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}
