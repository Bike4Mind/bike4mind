import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from './chat';
import { activeTodos, latestTodos, MAX_TODOS, parseTodos, todoProgress, type PlanItemStatus } from './todos';

const call = (
  id: string,
  input: Record<string, unknown>,
  status: ChatToolCall['status'] = 'done',
  name = 'todo_write',
  preview?: string
): ChatToolCall => ({ id, name, input, status, preview }) as ChatToolCall;
const slim = (items: readonly { content: string; status: string }[] | null) =>
  items?.map(({ content, status }) => ({ content, status })) ?? null;
const reply = (...toolCalls: ChatToolCall[]): ChatMessage =>
  ({ id: toolCalls.map(c => c.id).join(), role: 'assistant', content: '', createdAt: '', toolCalls }) as ChatMessage;

describe('parseTodos', () => {
  it('accepts a valid list and trims content', () => {
    expect(parseTodos([{ content: '  Fix it ', status: 'in_progress' }])).toEqual({
      todos: [{ id: expect.any(String), content: 'Fix it', status: 'in_progress' }],
    });
  });

  it('keeps activeForm and accepts cancelled', () => {
    expect(parseTodos([{ content: 'a', status: 'cancelled', activeForm: ' Doing a ' }])).toEqual({
      todos: [{ id: expect.any(String), content: 'a', status: 'cancelled', activeForm: 'Doing a' }],
    });
  });

  it('accepts an empty list, which clears the plan', () => {
    expect(parseTodos([])).toEqual({ todos: [] });
  });

  it.each([
    ['not an array', 'nope', /must be an array/],
    ['empty content', [{ content: ' ', status: 'pending' }], /non-empty "content"/],
    [
      'unknown status',
      [{ content: 'x', status: 'done' }],
      /status "done"; use pending, in_progress, completed, cancelled/,
    ],
    ['empty activeForm', [{ content: 'x', status: 'pending', activeForm: ' ' }], /empty "activeForm"/],
    ['long activeForm', [{ content: 'x', status: 'pending', activeForm: 'x'.repeat(201) }], /"activeForm" is over 200/],
    ['non-object', [null], /must be an object/],
    ['too long', [{ content: 'x'.repeat(201), status: 'pending' }], /over 200/],
    ['too many', Array.from({ length: MAX_TODOS + 1 }, () => ({ content: 'x', status: 'pending' })), /At most 50/],
  ])('rejects %s', (_name, value, message) => {
    const result = parseTodos(value);
    expect('error' in result && result.error).toMatch(message);
  });
});

describe('latestTodos', () => {
  it('returns null when no plan was written', () => {
    expect(latestTodos([reply()])).toBeNull();
  });

  it('takes the last accepted call, across messages, skipping failed and malformed ones', () => {
    const first = call('a', { todos: [{ content: 'one', status: 'pending' }] });
    const latest = call('b', { todos: [{ content: 'one', status: 'completed' }] });
    const failed = call('c', { todos: [{ content: 'ignored', status: 'pending' }] }, 'error');
    const malformed = call('d', { todos: 'nope' });
    expect(slim(latestTodos([reply(first), reply(latest, failed, malformed)]))).toEqual([
      { content: 'one', status: 'completed' },
    ]);
  });

  it('routes each plan tool to its adapter and ignores the rest', () => {
    const items = [{ content: 'one', status: 'pending' }];
    const only = (name: string, input: Record<string, unknown>) => latestTodos([reply(call('x', input, 'done', name))]);
    expect(slim(only('todo_write', { todos: items }))).toEqual(items);
    expect(slim(only('TodoWrite', { todos: items }))).toEqual(items);
    expect(slim(only('write_todos', { todos: [{ description: 'one', status: 'pending' }] }))).toEqual(items);
    expect(only('quest_master', { todos: items })).toBeNull();
    expect(only('toString', { todos: items })).toBeNull();
    expect(latestTodos([reply(call('x', { todos: items }, 'denied'))])).toBeNull();
  });

  it('skips a malformed TodoWrite or write_todos call, as it does a malformed todo_write', () => {
    const first = call('a', { todos: [{ content: 'one', status: 'pending' }] });
    for (const name of ['TodoWrite', 'write_todos']) {
      expect(slim(latestTodos([reply(first), reply(call('b', { todos: 'nope' }, 'done', name))]))).toEqual([
        { content: 'one', status: 'pending' },
      ]);
    }
  });

  it('lets the newest plan call win across families', () => {
    const create = call('t', { subject: 'task' }, 'done', 'TaskCreate');
    const written = call('w', { todos: [{ content: 'listed', status: 'pending' }] });
    expect(slim(latestTodos([reply(create), reply(written)]))).toEqual([{ content: 'listed', status: 'pending' }]);
    expect(slim(latestTodos([reply(written), reply(create)]))).toEqual([{ content: 'task', status: 'pending' }]);
  });
});

describe('Claude Code task stream', () => {
  const create = (id: string, subject: string, preview?: string) =>
    call(id, { subject, activeForm: `Doing ${subject}` }, 'done', 'TaskCreate', preview);
  const update = (id: string, input: Record<string, unknown>) => call(id, input, 'done', 'TaskUpdate');

  it('folds creates and updates from different replies into one plan', () => {
    const plan = latestTodos([
      reply(create('c1', 'a'), create('c2', 'b'), create('c3', 'c')),
      reply(update('u1', { taskId: '1', status: 'completed' }), update('u2', { taskId: '2', status: 'in_progress' })),
      reply(update('u3', { taskId: '3', status: 'deleted' }), update('u4', { taskId: '9', status: 'completed' })),
    ]);
    expect(plan).toEqual([
      { id: '1', content: 'a', activeForm: 'Doing a', status: 'completed' },
      { id: '2', content: 'b', activeForm: 'Doing b', status: 'in_progress' },
    ]);
  });

  it('takes the task id from the create result when it names one', () => {
    const plan = latestTodos([
      reply(create('c1', 'a', 'Task #7 created successfully: a')),
      reply(update('u1', { taskId: '7', status: 'completed' })),
    ]);
    expect(slim(plan)).toEqual([{ content: 'a', status: 'completed' }]);
  });

  it('reads a create result that is exactly "Task #7"', () => {
    const plan = latestTodos([
      reply(create('c1', 'a', 'Task #7')),
      reply(update('u1', { taskId: '7', status: 'completed' })),
    ]);
    expect(plan).toEqual([{ id: '7', content: 'a', activeForm: 'Doing a', status: 'completed' }]);
  });

  it('falls back to creation order when a create result names no id, so an update to a real id is dropped', () => {
    const plan = latestTodos([reply(create('c1', 'a')), reply(update('u1', { taskId: '7', status: 'completed' }))]);
    expect(plan).toEqual([{ id: '1', content: 'a', activeForm: 'Doing a', status: 'pending' }]);
  });

  it('keeps cancelled tasks, which todoProgress leaves out of the count', () => {
    const plan = latestTodos([
      reply(create('c1', 'a'), create('c2', 'b'), update('u1', { taskId: '2', status: 'cancelled' })),
    ]);
    expect(plan?.map(item => item.status)).toEqual(['pending', 'cancelled']);
    expect(todoProgress(plan!)).toMatchObject({ done: 0, total: 1 });
  });

  it('reads the whole thread for an update in the newest reply, but only shows it while current', () => {
    const user = (id: string) => ({ id, role: 'user', content: 'go', createdAt: '' }) as ChatMessage;
    const messages = [
      user('u1'),
      reply(create('c1', 'a')),
      user('u2'),
      reply(update('u1', { taskId: '1', status: 'completed' })),
    ];
    expect(slim(activeTodos(messages, false))).toEqual([{ content: 'a', status: 'completed' }]);
    expect(activeTodos([...messages, user('u3'), reply(), user('u4'), reply()], false)).toBeNull();
  });
});

describe('todoProgress', () => {
  it('counts done over the items that count, with the current item by activeForm', () => {
    const items = [
      { id: '1', content: 'a', status: 'completed' as const },
      { id: '2', content: 'b', activeForm: 'Doing b', status: 'in_progress' as const },
      { id: '3', content: 'c', status: 'cancelled' as const },
    ];
    expect(todoProgress(items)).toEqual({ done: 1, total: 2, current: 'Doing b' });
  });
});

describe('activeTodos', () => {
  const plan = (id: string, ...statuses: PlanItemStatus[]) =>
    call(id, { todos: statuses.map((status, index) => ({ content: `step ${index + 1}`, status })) });
  const other = (id: string): ChatToolCall => ({ id, name: 'glob_files', input: {}, status: 'done' }) as ChatToolCall;
  const user = (id: string): ChatMessage => ({ id, role: 'user', content: 'go on', createdAt: '' }) as ChatMessage;

  it('shows a plan the reply in flight just wrote', () => {
    const messages = [user('u1'), reply(plan('p1', 'in_progress'))];
    expect(slim(activeTodos(messages, true))).toEqual([{ content: 'step 1', status: 'in_progress' }]);
    expect(activeTodos(messages, false)).toHaveLength(1);
  });

  it('holds a plan from the previous reply while a turn runs, and drops it once the turn ends', () => {
    // The user asked something else and the reply in flight has not touched the plan.
    const messages = [user('u1'), reply(plan('p1', 'in_progress')), user('u2'), reply(other('g1'))];
    expect(activeTodos(messages, true)).toHaveLength(1);
    expect(activeTodos(messages, false)).toBeNull();
  });

  it('does not revive an older plan when the newest todo_write is rejected by the parser', () => {
    const tooLong = call('p2', { todos: [{ content: 'x'.repeat(201), status: 'pending' }] });
    const messages = [user('u1'), reply(plan('p1', 'pending')), user('u2'), reply(tooLong)];
    expect(activeTodos(messages, false)).toBeNull();
  });

  it('ignores a plan two replies back, however the turn stands', () => {
    const messages = [
      user('u1'),
      reply(plan('p1', 'pending')),
      user('u2'),
      reply(other('g1')),
      user('u3'),
      reply(other('g2')),
    ];
    expect(activeTodos(messages, true)).toBeNull();
    expect(activeTodos(messages, false)).toBeNull();
  });

  it('takes the newest plan when a turn rewrites one it already had', () => {
    const messages = [user('u1'), reply(plan('p1', 'pending'), plan('p2', 'completed'))];
    expect(slim(activeTodos(messages, false))).toEqual([{ content: 'step 1', status: 'completed' }]);
  });

  it('is null with no plan anywhere, and on an empty thread', () => {
    expect(activeTodos([user('u1'), reply(other('g1'))], true)).toBeNull();
    expect(activeTodos([], true)).toBeNull();
  });
});
