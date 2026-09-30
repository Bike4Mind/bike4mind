import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TodoItem } from '@shared/todos';
import { TodoPanel } from './TodoPanel';

const todos: TodoItem[] = [
  { content: 'Read the code', status: 'completed' },
  { content: 'Write the fix', status: 'in_progress' },
  { content: 'Run the tests', status: 'pending' },
];
const render = (list: TodoItem[] | null, turnOpen: boolean) =>
  renderToStaticMarkup(<TodoPanel todos={list} turnOpen={turnOpen} />);

describe('TodoPanel', () => {
  it('draws the items with their progress', () => {
    const html = render(todos, true);
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('chat-todo-item-in_progress');
    expect(html).toContain('Run the tests');
  });

  it('draws nothing without a plan', () => {
    expect(render(null, true)).toBe('');
    expect(render([], true)).toBe('');
  });

  it('stays while a turn runs after the last item is done, and leaves once the turn ends', () => {
    const finished = todos.map(todo => ({ ...todo, status: 'completed' as const }));
    expect(render(finished, true)).toContain('3 of 3 done');
    expect(render(finished, false)).toBe('');
  });
});
