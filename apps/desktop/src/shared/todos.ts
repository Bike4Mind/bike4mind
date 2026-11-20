import {
  fromClaudeTasks,
  fromTodoWrite,
  PLAN_ITEM_STATUSES,
  PLAN_TOOL_ADAPTERS,
  planProgress,
  type ClaudeTaskCall,
  type PlanItem,
  type PlanItemStatus,
} from '@bike4mind/common';
import type { ChatMessage, ChatToolCall } from './chat';
import { own } from './ownKeys';

export type { PlanItem, PlanItemStatus };

export const TODO_TOOL_NAME = 'todo_write';
export const MAX_TODOS = 50;
export const MAX_TODO_CHARS = 200;

/**
 * The shared adapters Desktop reads a plan from. `quest_master` is left out: its adapter takes
 * the quest list itself, not a tool call's input, so a call named that would yield a bogus plan.
 */
const { quest_master: _questMaster, ...PLAN_TOOLS } = PLAN_TOOL_ADAPTERS;

const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate']);

/**
 * The plan a `todo_write` call carries, or why it is not one.
 *
 * Shared by the tool, which refuses a bad list so the model corrects it, and by the renderer,
 * which draws the plan from the call's own input: the transcript is the only store, so a plan
 * survives a restart and a window opened mid-turn with nothing persisted beside it.
 */
export function parseTodos(value: unknown): { todos: PlanItem[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'The "todos" argument is required and must be an array.' };
  if (value.length > MAX_TODOS) return { error: `At most ${MAX_TODOS} todos are allowed; merge or drop some.` };

  const todos: { content: string; status: PlanItemStatus; activeForm?: string }[] = [];
  for (const [index, entry] of value.entries()) {
    const item = entry as { content?: unknown; status?: unknown; activeForm?: unknown } | null;
    const label = `Todo ${index + 1}`;
    if (typeof item !== 'object' || item === null) return { error: `${label} must be an object.` };
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!content) return { error: `${label} needs non-empty "content".` };
    if (content.length > MAX_TODO_CHARS) return { error: `${label} is over ${MAX_TODO_CHARS} characters; shorten it.` };
    if (!PLAN_ITEM_STATUSES.includes(item.status as PlanItemStatus)) {
      return { error: `${label} has status ${JSON.stringify(item.status)}; use ${PLAN_ITEM_STATUSES.join(', ')}.` };
    }
    const todo: (typeof todos)[number] = { content, status: item.status as PlanItemStatus };
    if (item.activeForm !== undefined) {
      const activeForm = typeof item.activeForm === 'string' ? item.activeForm.trim() : '';
      if (!activeForm) return { error: `${label} has an empty "activeForm"; omit it or give a short phrase.` };
      if (activeForm.length > MAX_TODO_CHARS) {
        return { error: `${label} "activeForm" is over ${MAX_TODO_CHARS} characters; shorten it.` };
      }
      todo.activeForm = activeForm;
    }
    todos.push(todo);
  }
  // normalizePlan demotes a second in_progress item; the tool counts before this and warns.
  return { todos: fromTodoWrite({ todos }).plan.items };
}

/** The tool result's `Task #<id>` text, when it names the id the task was given. */
function taskResult(call: ChatToolCall): ClaudeTaskCall['result'] {
  const taskId = call.name === 'TaskCreate' ? /Task #([^\s:]+)/.exec(call.preview ?? '')?.[1] : undefined;
  return taskId ? { taskId } : undefined;
}

/** Every plan-writing call that was accepted, oldest first. */
function planCalls(messages: readonly ChatMessage[]): { call: ChatToolCall; message: number }[] {
  return messages.flatMap((message, m) =>
    (message.toolCalls ?? [])
      .filter(call => own(PLAN_TOOLS, call.name) && call.status !== 'error' && call.status !== 'denied')
      .map(call => ({ call, message: m }))
  );
}

/** The plan the newest readable call sets, with the thread index of that call. */
function planFrom(
  calls: readonly { call: ChatToolCall; message: number }[]
): { items: PlanItem[]; message: number } | null {
  for (let c = calls.length - 1; c >= 0; c -= 1) {
    const { call, message } = calls[c];
    if (TASK_TOOLS.has(call.name)) {
      // Each task call is a delta, so the plan is the fold of the whole stream up to this one.
      const tasks = calls.slice(0, c + 1).filter(entry => TASK_TOOLS.has(entry.call.name));
      const items = fromClaudeTasks(
        tasks.map(({ call: task }) => ({ name: task.name, input: task.input, result: taskResult(task) }))
      ).plan.items;
      return { items, message };
    }
    if (call.name === TODO_TOOL_NAME) {
      const parsed = parseTodos(call.input.todos);
      if ('todos' in parsed) return { items: parsed.todos, message };
      continue;
    }
    const adapter = own(PLAN_TOOLS, call.name);
    return adapter ? { items: adapter(call.input).plan.items, message } : null;
  }
  return null;
}

/** The most recent plan in a thread: what the last accepted plan call set, or null if none. */
export function latestTodos(messages: readonly ChatMessage[]): PlanItem[] | null {
  return planFrom(planCalls(messages))?.items ?? null;
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
export function activeTodos(messages: readonly ChatMessage[], turnOpen: boolean): PlanItem[] | null {
  const window = turnOpen ? 2 : 1;
  // Thread index of the oldest assistant reply inside the window.
  let start = -1;
  for (let m = messages.length - 1, seen = 0; m >= 0 && seen < window; m -= 1) {
    if (messages[m].role !== 'assistant') continue;
    start = m;
    seen += 1;
  }
  if (start < 0) return null;
  // Recency is judged on the call the plan is read from, so a rejected newest call cannot revive
  // an older plan; the task fold still reads the whole thread.
  const plan = planFrom(planCalls(messages));
  return plan && plan.message >= start ? plan.items : null;
}

/** Done/total over the items that count (cancelled ones are left out), plus the current and next item. */
export function todoProgress(items: readonly PlanItem[]) {
  return planProgress({ version: 1, source: 'desktop', items: [...items], updatedAt: 0 });
}
