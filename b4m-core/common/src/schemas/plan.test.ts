import { describe, expect, it } from 'vitest';
import {
  fromClaudeTasks,
  fromClaudeTodoWrite,
  fromCliTodos,
  fromQuestMaster,
  fromTodoWrite,
  normalizePlan,
  PLAN_ITEM_STATUSES,
  PLAN_TOOL_ADAPTERS,
  PlanItemSchema,
  PlanSchema,
  planProgress,
} from './plan';

const item = (content: string, status = 'pending', extra = {}) => ({ content, status, ...extra });
const normalized = (items: unknown) => normalizePlan({ version: 1, source: 'test', updatedAt: 123, items });

describe('plan schemas', () => {
  it('accepts every status and rejects invalid shape, size and depth', () => {
    for (const status of PLAN_ITEM_STATUSES) {
      expect(PlanItemSchema.safeParse({ id: 'a', content: 'a', status }).success).toBe(true);
    }
    const valid = normalized([item('a')]).plan;
    expect(PlanSchema.safeParse(valid).success).toBe(true);
    for (const change of [
      { version: 2 },
      { source: '' },
      { updatedAt: -1 },
      { updatedAt: 1.5 },
      { items: Array(51).fill(valid.items[0]) },
    ]) {
      expect(PlanSchema.safeParse({ ...valid, ...change }).success).toBe(false);
    }
    for (const change of [
      { id: '' },
      { content: '' },
      { content: 'a'.repeat(201) },
      { status: 'done' },
      { activeForm: 'a'.repeat(201) },
    ]) {
      expect(PlanItemSchema.safeParse({ ...valid.items[0], ...change }).success).toBe(false);
    }
    const leaf = valid.items[0];
    expect(PlanItemSchema.safeParse({ ...leaf, children: [{ ...leaf, children: [leaf] }] }).success).toBe(false);
    expect(PlanItemSchema.safeParse({ ...leaf, children: Array(51).fill(leaf) }).success).toBe(false);
  });
});

describe('normalizePlan', () => {
  it('trims, caps, drops empty entries, repairs statuses and ids without mutating input', () => {
    const input = [
      item('  First  ', 'in_progress', { id: ' first ', activeForm: ' Working ', note: ' note ' }),
      item('x'.repeat(201), 'in_progress', { id: 'first' }),
      item(' ', 'pending'),
      null,
      item('Other', 'bad'),
    ];
    const before = JSON.stringify(input);
    const { plan, warnings } = normalized(input);
    expect(plan.items).toEqual([
      { id: 'first', content: 'First', status: 'in_progress', activeForm: 'Working', note: 'note' },
      { id: 'first-2', content: 'x'.repeat(200), status: 'pending' },
      expect.objectContaining({ content: 'Other', status: 'pending' }),
    ]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(input)).toBe(before);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  it('keeps one in_progress in each sibling list and drops grandchildren', () => {
    const children = [item('a', 'in_progress', { children: [item('too deep')] }), item('b', 'in_progress')];
    const { plan, warnings } = normalized([
      item('one', 'in_progress', { children }),
      item('two', 'in_progress', { children }),
    ]);
    expect(plan.items.map(entry => entry.status)).toEqual(['in_progress', 'pending']);
    for (const parent of plan.items) {
      expect(parent.children?.map(entry => entry.status)).toEqual(['in_progress', 'pending']);
      expect(parent.children?.[0]).not.toHaveProperty('children');
    }
    expect(warnings.some(warning => warning.includes('nesting'))).toBe(true);
  });

  it('has stable unique ids across status updates and unrelated insertions', () => {
    const first = normalized([item('a'), item('b'), item('a')]).plan;
    const second = normalized([item('new'), item('a', 'completed'), item('b'), item('a')]).plan;
    expect(second.items.slice(1).map(entry => entry.id)).toEqual(first.items.map(entry => entry.id));
    expect(new Set(first.items.map(entry => entry.id)).size).toBe(3);
    expect(normalizePlan(first)).toEqual({ plan: first, warnings: [] });
  });

  it('caps each list and optional labels', () => {
    const entries = Array.from({ length: 51 }, (_, i) => item(String(i)));
    const { plan, warnings } = normalized([
      item('parent', 'pending', { children: entries, activeForm: 'x'.repeat(201) }),
      ...entries,
    ]);
    expect(plan.items).toHaveLength(50);
    expect(plan.items[0].children).toHaveLength(50);
    expect(plan.items[0].activeForm).toHaveLength(200);
    expect(warnings.filter(warning => warning.includes('50 items'))).toHaveLength(2);
  });

  it.each([null, [], 'bad', {}, { version: 9, source: '', updatedAt: Infinity, items: false }])(
    'repairs malformed metadata: %j',
    value => {
      const { plan, warnings } = normalizePlan(value);
      expect(PlanSchema.safeParse(plan).success).toBe(true);
      expect(warnings.length).toBeGreaterThan(0);
    }
  );
});

describe('planProgress', () => {
  it.each([[], [item('skip', 'cancelled')]])('handles empty and all cancelled plans', items => {
    expect(planProgress(normalized(items).plan)).toEqual({ done: 0, total: 0 });
  });

  it('uses activeForm labels and excludes cancelled items', () => {
    expect(
      planProgress(
        normalized([
          item('done', 'completed'),
          item('skip', 'cancelled'),
          item('work', 'in_progress', { activeForm: 'Working' }),
          item('next', 'pending', { activeForm: 'Starting' }),
        ]).plan
      )
    ).toEqual({ done: 1, total: 3, current: 'Working', next: 'Starting' });
  });

  it('has no current when none is in progress and no next when finished', () => {
    expect(planProgress(normalized([item('todo')]).plan)).toEqual({ done: 0, total: 1, next: 'todo' });
    expect(planProgress(normalized([item('done', 'completed')]).plan)).toEqual({ done: 1, total: 1 });
  });

  it('counts leaf work and excludes cancelled subtrees', () => {
    expect(
      planProgress(
        normalized([
          item('group', 'in_progress', {
            children: [item('done', 'completed'), item('current', 'in_progress'), item('skip', 'cancelled')],
          }),
          item('cancelled group', 'cancelled', { children: [item('hidden')] }),
          item('empty group', 'pending', { children: [] }),
        ]).plan
      )
    ).toEqual({ done: 1, total: 3, current: 'current', next: 'empty group' });
  });
});

describe('plan adapters', () => {
  it('adapts Desktop todos and preserves injected timestamps', () => {
    const result = fromTodoWrite({ todos: [item(' work ', 'in_progress')] }, { updatedAt: 456 });
    expect(result.plan).toMatchObject({
      version: 1,
      source: 'todo_write',
      updatedAt: 456,
      items: [{ content: 'work', status: 'in_progress' }],
    });
    expect(result.warnings).toEqual([]);
  });

  it('adapts Claude TodoWrite arrays and tool inputs with active forms', () => {
    const todos = [item('work', 'in_progress', { activeForm: 'Working' })];
    expect(fromClaudeTodoWrite(todos)).toEqual(fromClaudeTodoWrite({ todos }));
    expect(fromClaudeTodoWrite(todos).plan.items[0].activeForm).toBe('Working');
  });

  it('adapts CLI descriptions including cancelled todos', () => {
    const todos = [{ description: 'Skip', status: 'cancelled' }];
    expect(fromCliTodos(todos)).toEqual(fromCliTodos({ todos }));
    expect(fromCliTodos(todos).plan.items[0]).toMatchObject({ content: 'Skip', status: 'cancelled' });
  });

  it('prefers content over the deprecated description alias and warns once', () => {
    const result = fromCliTodos([
      { content: 'New', description: 'Old', status: 'pending' },
      { description: 'Alias only', status: 'pending' },
      { description: 'Another alias', status: 'pending' },
    ]);
    expect(result.plan.items.map(i => i.content)).toEqual(['New', 'Alias only', 'Another alias']);
    expect(result.warnings.filter(w => w.includes('deprecated'))).toHaveLength(1);
    expect(fromCliTodos([{ content: 'Only', status: 'pending' }]).warnings).toEqual([]);
  });

  it('keeps activeForm and demotes extra in_progress CLI todos without throwing', () => {
    const result = fromCliTodos([
      { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      { content: 'B', status: 'in_progress' },
    ]);
    expect(result.plan.items.map(i => i.status)).toEqual(['in_progress', 'pending']);
    expect(result.plan.items[0].activeForm).toBe('Doing A');
    expect(result.warnings).toHaveLength(1);
  });

  it('folds task creates, partial updates and deletions in creation order', () => {
    const calls = [
      { name: 'TaskCreate', input: { subject: 'First', activeForm: 'Doing first', description: 'Details' } },
      { name: 'TaskCreate', input: { subject: 'Second' }, result: { taskId: 'custom' } },
      { name: 'TaskCreate', input: { subject: 'Drop' } },
      { name: 'TaskUpdate', input: { taskId: 'custom', status: 'in_progress' } },
      { name: 'TaskUpdate', input: { taskId: '1', subject: 'Renamed', status: 'completed' } },
      { name: 'TaskUpdate', input: { taskId: '3', status: 'deleted' } },
    ];
    const snapshot = JSON.stringify(calls);
    const result = fromClaudeTasks(calls);
    expect(result.warnings).toEqual([]);
    expect(result.plan.items).toEqual([
      { id: '1', content: 'Renamed', status: 'completed', activeForm: 'Doing first', note: 'Details' },
      { id: 'custom', content: 'Second', status: 'in_progress' },
    ]);
    expect(JSON.stringify(calls)).toBe(snapshot);
    expect(fromClaudeTasks(calls)).toEqual(result);
  });

  it('warns on unknown task updates, duplicate ids and unknown calls', () => {
    const result = fromClaudeTasks([
      { name: 'TaskUpdate', input: { taskId: 'missing', status: 'completed' } },
      { name: 'TaskCreate', input: { subject: 'First', taskId: 'a' } },
      { name: 'TaskCreate', input: { subject: 'Duplicate', taskId: 'a' } },
      { name: 'Other', input: {} },
    ]);
    expect(result.warnings).toHaveLength(3);
    expect(result.plan.items).toHaveLength(1);
  });

  it('maps QuestMaster children and derives group statuses', () => {
    const quest = (id: string, statuses: string[]) => ({
      id,
      title: id,
      description: ' Details ',
      complexity: 'small',
      subQuests: statuses.map((status, i) => ({ id: `${id}-${i}`, title: String(i), status, evidence: ' Evidence ' })),
    });
    const result = fromQuestMaster([
      quest('pending', ['not_started']),
      quest('completed', ['completed', 'skipped']),
      quest('cancelled', ['skipped']),
      quest('working', ['completed', 'not_started']),
      quest('active', ['in_progress']),
      quest('empty', ['deleted']),
    ]);
    expect(result.plan.items.map(entry => entry.status)).toEqual([
      'pending',
      'completed',
      'cancelled',
      'in_progress',
      'pending',
      'pending',
    ]);
    expect(result.plan.items[0].children?.[0]).toMatchObject({ id: 'pending-0', status: 'pending', note: 'Evidence' });
    expect(result.plan.items[1].children?.[1].status).toBe('cancelled');
    expect(result.plan.items[5].children).toEqual([]);
  });

  it('derives quest status only from retained normalized children', () => {
    const result = fromQuestMaster([
      {
        id: 'q',
        title: 'Quest',
        subQuests: [
          ...Array.from({ length: 50 }, (_, index) => ({ id: String(index), title: 'Done', status: 'completed' })),
          { id: 'overflow', title: 'Not retained', status: 'in_progress' },
        ],
      },
      { id: 'empty', title: 'Empty', subQuests: [{ title: ' ', status: 'completed' }] },
    ]);
    expect(result.plan.items.map(entry => entry.status)).toEqual(['completed', 'pending']);
    expect(result.plan.items[0].children).toHaveLength(50);
    expect(result.plan.items[1].children).toEqual([]);
  });

  it.each(Object.entries(PLAN_TOOL_ADAPTERS))('registry adapter %s repairs malformed input', (_name, adapter) => {
    const result = adapter(null);
    expect(PlanSchema.safeParse(result.plan).success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('registers all five formats by their tool names', () => {
    expect(PLAN_TOOL_ADAPTERS).toEqual({
      todo_write: fromTodoWrite,
      TodoWrite: fromClaudeTodoWrite,
      TaskCreate: fromClaudeTasks,
      TaskUpdate: fromClaudeTasks,
      write_todos: fromCliTodos,
      quest_master: fromQuestMaster,
    });
  });
});
