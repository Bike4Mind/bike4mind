import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from './chat';
import { activeTodos, countTodos, latestTodos, MAX_TODOS, parseTodos, type TodoStatus } from './todos';

const call = (id: string, input: Record<string, unknown>, status: ChatToolCall['status'] = 'done'): ChatToolCall =>
  ({ id, name: 'todo_write', input, status }) as ChatToolCall;
const reply = (...toolCalls: ChatToolCall[]): ChatMessage =>
  ({ id: toolCalls.map(c => c.id).join(), role: 'assistant', content: '', createdAt: '', toolCalls }) as ChatMessage;

describe('parseTodos', () => {
  it('accepts a valid list and trims content', () => {
    expect(parseTodos([{ content: '  Fix it ', status: 'in_progress' }])).toEqual({
      todos: [{ content: 'Fix it', status: 'in_progress' }],
    });
  });

  it('accepts an empty list, which clears the plan', () => {
    expect(parseTodos([])).toEqual({ todos: [] });
  });

  it.each([
    ['not an array', 'nope', /must be an array/],
    ['empty content', [{ content: ' ', status: 'pending' }], /non-empty "content"/],
    ['unknown status', [{ content: 'x', status: 'done' }], /status "done"/],
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
    expect(latestTodos([reply(first), reply(latest, failed, malformed)])).toEqual([
      { content: 'one', status: 'completed' },
    ]);
  });

  it('counts by status', () => {
    expect(
      countTodos([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
        { content: 'c', status: 'pending' },
      ])
    ).toEqual({ pending: 2, in_progress: 0, completed: 1 });
  });
});

describe('activeTodos', () => {
  const plan = (id: string, ...statuses: TodoStatus[]) =>
    call(id, { todos: statuses.map((status, index) => ({ content: `step ${index + 1}`, status })) });
  const other = (id: string): ChatToolCall => ({ id, name: 'glob_files', input: {}, status: 'done' }) as ChatToolCall;
  const user = (id: string): ChatMessage => ({ id, role: 'user', content: 'go on', createdAt: '' }) as ChatMessage;

  it('shows a plan the reply in flight just wrote', () => {
    const messages = [user('u1'), reply(plan('p1', 'in_progress'))];
    expect(activeTodos(messages, true)).toEqual([{ content: 'step 1', status: 'in_progress' }]);
    expect(activeTodos(messages, false)).toHaveLength(1);
  });

  it('holds a plan from the previous reply while a turn runs, and drops it once the turn ends', () => {
    // The user asked something else and the reply in flight has not touched the plan.
    const messages = [user('u1'), reply(plan('p1', 'in_progress')), user('u2'), reply(other('g1'))];
    expect(activeTodos(messages, true)).toHaveLength(1);
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
    expect(activeTodos(messages, false)).toEqual([{ content: 'step 1', status: 'completed' }]);
  });

  it('is null with no plan anywhere, and on an empty thread', () => {
    expect(activeTodos([user('u1'), reply(other('g1'))], true)).toBeNull();
    expect(activeTodos([], true)).toBeNull();
  });
});
