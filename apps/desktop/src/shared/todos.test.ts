import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from './chat';
import { countTodos, latestTodos, MAX_TODOS, parseTodos } from './todos';

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
