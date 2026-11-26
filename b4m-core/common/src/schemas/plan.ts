import * as z from 'zod';
import { normalizeSubQuestStatus, type QuestMasterData, type SubQuestStatus } from '../types/entities/QuestTypes';

export const PLAN_ITEM_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;

const planLeafSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(200),
  activeForm: z.string().min(1).max(200).optional(),
  status: z.enum(PLAN_ITEM_STATUSES),
  note: z.string().optional(),
});

export const PlanItemSchema = planLeafSchema.extend({
  children: z
    .array(planLeafSchema.extend({ children: z.never().optional() }))
    .max(50)
    .optional(),
});

export const PlanSchema = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  items: z.array(PlanItemSchema).max(50),
  updatedAt: z.number().int().nonnegative(),
});

export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

/** Joy palette names, kept as strings so common stays UI-free. */
export type PlanStatusColor = 'success' | 'warning' | 'neutral' | 'danger';

/**
 * Display tokens shared by every surface that shows plan statuses. QuestMaster's chip colours
 * (apps/client/app/components/GenAI/subQuestStatusDisplay.ts) read these through
 * SUB_QUEST_TO_PLAN_STATUS, so a skipped sub-quest renders like a cancelled plan item.
 */
export const PLAN_STATUS_DISPLAY: Readonly<Record<PlanItemStatus, { color: PlanStatusColor; label: string }>> = {
  pending: { color: 'neutral', label: 'Pending' },
  in_progress: { color: 'warning', label: 'In progress' },
  completed: { color: 'success', label: 'Completed' },
  cancelled: { color: 'neutral', label: 'Cancelled' },
};

/** `deleted` has no plan counterpart: fromQuestMaster drops deleted sub-quests. */
export const SUB_QUEST_TO_PLAN_STATUS: Readonly<Record<SubQuestStatus, PlanItemStatus | null>> = {
  not_started: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  skipped: 'cancelled',
  deleted: null,
};

/** Inverse of SUB_QUEST_TO_PLAN_STATUS, for writing a plan status back to a stored sub-quest. */
export const PLAN_TO_SUB_QUEST_STATUS: Readonly<Record<PlanItemStatus, SubQuestStatus>> = {
  pending: 'not_started',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'skipped',
};
export type PlanItem = z.infer<typeof PlanItemSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface NormalizedPlan {
  plan: Plan;
  warnings: string[];
}

/** Timestamps are supplied by the caller so replaying the same input is deterministic. */
export interface PlanAdapterOptions {
  updatedAt?: number;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `plan-${(hash >>> 0).toString(36)}`;
}

/** Repairs untrusted plan data, dropping unusable items and reporting every lossy repair. */
export function normalizePlan(value: unknown): NormalizedPlan {
  const input = record(value);
  const warnings: string[] = [];
  const ids = new Set<string>();
  const text = (value: unknown, path: string, cap?: number): string => {
    if (typeof value !== 'string') {
      warnings.push(`${path}: expected a string.`);
      return '';
    }
    const trimmed = value.trim();
    if (cap !== undefined && trimmed.length > cap) warnings.push(`${path}: capped at ${cap} characters.`);
    return cap === undefined ? trimmed : trimmed.slice(0, cap);
  };
  const items = (value: unknown, path: string, parentId?: string): PlanItem[] => {
    if (!Array.isArray(value)) {
      warnings.push(`${path}: expected an array.`);
      return [];
    }
    if (value.length > 50) warnings.push(`${path}: capped at 50 items.`);
    let hasCurrent = false;
    const result: PlanItem[] = [];
    for (const [index, raw] of value.slice(0, 50).entries()) {
      const item = record(raw);
      const itemPath = `${path}[${index}]`;
      const content = text(item.content, `${itemPath}.content`, 200);
      if (!content) {
        warnings.push(`${itemPath}: dropped empty item.`);
        continue;
      }
      let status: PlanItemStatus = 'pending';
      if (PLAN_ITEM_STATUSES.includes(item.status as PlanItemStatus)) status = item.status as PlanItemStatus;
      else warnings.push(`${itemPath}.status: replaced invalid status with pending.`);
      if (status === 'in_progress') {
        if (hasCurrent) {
          status = 'pending';
          warnings.push(`${itemPath}.status: only the first item per level stays in_progress.`);
        }
        hasCurrent = true;
      }
      const suppliedId = typeof item.id === 'string' ? item.id.trim() : '';
      const baseId = suppliedId || stableId(`${parentId ?? input.source}:${content}`);
      let id = baseId;
      let suffix = 2;
      while (ids.has(id)) id = `${baseId}-${suffix++}`;
      // Derived ids are internal, so only a caller-supplied id gets a warning it can act on.
      if (id !== baseId && suppliedId) warnings.push(`${itemPath}.id: replaced duplicate id.`);
      ids.add(id);
      const normalized: PlanItem = { id, content, status };
      if (item.activeForm !== undefined) {
        const activeForm = text(item.activeForm, `${itemPath}.activeForm`, 200);
        if (activeForm) normalized.activeForm = activeForm;
      }
      if (item.note !== undefined) normalized.note = text(item.note, `${itemPath}.note`);
      if (item.children !== undefined) {
        if (parentId !== undefined) warnings.push(`${itemPath}.children: dropped nesting below one level.`);
        else
          normalized.children = items(item.children, `${itemPath}.children`, id).map(child =>
            planLeafSchema.parse(child)
          );
      }
      result.push(normalized);
    }
    return result;
  };
  if (input.version !== 1) warnings.push('version: replaced with 1.');
  const source = text(input.source, 'source') || 'unknown';
  const updatedAt =
    typeof input.updatedAt === 'number' && Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0
      ? input.updatedAt
      : 0;
  if (updatedAt !== input.updatedAt) warnings.push('updatedAt: replaced invalid timestamp with 0.');
  return { plan: { version: 1, source, items: items(input.items, 'items'), updatedAt }, warnings };
}

export interface PlanProgress {
  done: number;
  total: number;
  current?: string;
  next?: string;
}

/** Leaf work items: a group counts as its children, and a cancelled group drops its whole subtree. */
export function planLeaves(items: PlanItem[]): PlanItem[] {
  return items
    .filter(item => item.status !== 'cancelled')
    .flatMap(item => (item.children?.length ? item.children : [item]))
    .filter(item => item.status !== 'cancelled');
}

/** Counts leaf work, not both a group and its children. Cancelled groups exclude their subtree. */
export function planProgress(plan: Plan): PlanProgress {
  const leaves = planLeaves(plan.items);
  const current = leaves.find(item => item.status === 'in_progress');
  const next = leaves.find(item => item.status === 'pending');
  return {
    done: leaves.filter(item => item.status === 'completed').length,
    total: leaves.length,
    ...(current ? { current: current.activeForm ?? current.content } : {}),
    ...(next ? { next: next.activeForm ?? next.content } : {}),
  };
}

function adapt(source: string, items: unknown, options: PlanAdapterOptions): NormalizedPlan {
  return normalizePlan({ version: 1, source, items, updatedAt: options.updatedAt ?? 0 });
}

export function fromTodoWrite(input: unknown, options: PlanAdapterOptions = {}): NormalizedPlan {
  return adapt('todo_write', record(input).todos, options);
}

export function fromClaudeTodoWrite(input: unknown, options: PlanAdapterOptions = {}): NormalizedPlan {
  return adapt('TodoWrite', Array.isArray(input) ? input : record(input).todos, options);
}

/** `content` wins; `description` is a deprecated alias that warns once per call. */
export function fromCliTodos(input: unknown, options: PlanAdapterOptions = {}): NormalizedPlan {
  const todos = Array.isArray(input) ? input : record(input).todos;
  if (!Array.isArray(todos)) return adapt('write_todos', todos, options);
  const usesAlias = todos.some(item => typeof record(item).description === 'string');
  const result = adapt(
    'write_todos',
    todos.map(item => {
      const { description, ...rest } = record(item);
      const content = typeof rest.content === 'string' && rest.content.trim() ? rest.content : undefined;
      return { ...rest, content: content ?? (typeof description === 'string' ? description : rest.content) };
    }),
    options
  );
  return usesAlias
    ? { plan: result.plan, warnings: ["description is deprecated; use 'content'.", ...result.warnings] }
    : result;
}

export interface ClaudeTaskCall {
  name: 'TaskCreate' | 'TaskUpdate';
  input: {
    taskId?: string;
    subject?: string;
    description?: string;
    activeForm?: string;
    status?: PlanItemStatus | 'deleted';
  };
  result?: { taskId?: string };
}

/** Pass the ordered history, not just the latest update. Creates without result ids use 1-based ids. */
export function fromClaudeTasks(input: unknown, options: PlanAdapterOptions = {}): NormalizedPlan {
  const tasks = new Map<string, Record<string, unknown>>();
  const warnings: string[] = [];
  let created = 0;
  if (!Array.isArray(input)) return adapt('claude_tasks', input, options);
  for (const [index, raw] of input.entries()) {
    const call = record(raw);
    const args = record(call.input);
    if (call.name === 'TaskCreate') {
      created++;
      const id = record(call.result).taskId ?? args.taskId ?? String(created);
      if (typeof id !== 'string' || !id.trim() || tasks.has(id)) {
        warnings.push(`calls[${index}]: ignored invalid or duplicate task id.`);
        continue;
      }
      tasks.set(id, {
        id,
        content: args.subject,
        activeForm: args.activeForm,
        note: args.description,
        status: 'pending',
      });
    } else if (call.name === 'TaskUpdate') {
      const id = args.taskId;
      const task = typeof id === 'string' ? tasks.get(id) : undefined;
      if (!task || typeof id !== 'string') {
        warnings.push(`calls[${index}]: ignored update for unknown task.`);
        continue;
      }
      if (args.status === 'deleted') {
        tasks.delete(id);
        continue;
      }
      for (const [field, target] of [
        ['subject', 'content'],
        ['description', 'note'],
        ['activeForm', 'activeForm'],
        ['status', 'status'],
      ]) {
        if (args[field] !== undefined) task[target] = args[field];
      }
    } else warnings.push(`calls[${index}]: ignored unknown tool.`);
  }
  const result = adapt('claude_tasks', [...tasks.values()], options);
  return { plan: result.plan, warnings: [...warnings, ...result.warnings] };
}

function questStatus(children: readonly { status: unknown }[]): PlanItemStatus {
  const active = children.filter(child => child.status !== 'cancelled');
  if (children.length > 0 && active.length === 0) return 'cancelled';
  if (active.length > 0 && active.every(child => child.status === 'completed')) return 'completed';
  if (active.some(child => child.status === 'in_progress' || child.status === 'completed')) return 'in_progress';
  return 'pending';
}

export function fromQuestMaster(input: readonly QuestMasterData[], options?: PlanAdapterOptions): NormalizedPlan;
export function fromQuestMaster(input: unknown, options?: PlanAdapterOptions): NormalizedPlan;
export function fromQuestMaster(input: unknown, options: PlanAdapterOptions = {}): NormalizedPlan {
  if (!Array.isArray(input)) return adapt('quest_master', input, options);
  const warnings: string[] = [];
  const items = input.map((raw, index) => {
    const quest = record(raw);
    if (!Array.isArray(quest.subQuests)) warnings.push(`quests[${index}].subQuests: expected an array.`);
    const children = (Array.isArray(quest.subQuests) ? quest.subQuests : [])
      .map(record)
      .map(child => ({ child, canonical: normalizeSubQuestStatus(child.status) }))
      .filter(({ canonical }) => canonical !== 'deleted')
      .map(({ child, canonical }) => ({
        id: child.id,
        content: child.title,
        // An unrecognised token passes through raw so normalizePlan reports it.
        status: canonical === null ? child.status : SUB_QUEST_TO_PLAN_STATUS[canonical],
        note: child.evidence,
      }));
    return { id: quest.id, content: quest.title, note: quest.description, status: 'pending', children };
  });
  const result = adapt('quest_master', items, options);
  const derived = normalizePlan({
    ...result.plan,
    items: result.plan.items.map(item => ({ ...item, status: questStatus(item.children ?? []) })),
  });
  return { plan: derived.plan, warnings: [...warnings, ...result.warnings, ...derived.warnings] };
}

export const PLAN_TOOL_ADAPTERS = {
  todo_write: fromTodoWrite,
  TodoWrite: fromClaudeTodoWrite,
  TaskCreate: fromClaudeTasks,
  TaskUpdate: fromClaudeTasks,
  write_todos: fromCliTodos,
  quest_master: fromQuestMaster,
} as const;
