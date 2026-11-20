// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@shared/todos';
import { TodoPanel } from './TodoPanel';

const todos: PlanItem[] = [
  { id: '1', content: 'Read the code', status: 'completed' },
  { id: '2', content: 'Write the fix', status: 'in_progress' },
  { id: '3', content: 'Run the tests', status: 'pending' },
];
const render = (list: PlanItem[] | null, turnOpen: boolean) =>
  renderToStaticMarkup(<TodoPanel todos={list} turnOpen={turnOpen} />);

describe('TodoPanel', () => {
  it('opens collapsed, with the count and the item in hand on its one line', () => {
    const html = render(todos, true);
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('Write the fix');
    expect(html).toContain('aria-expanded="false"');
    // The list itself is not drawn until the bar is clicked.
    expect(html).not.toContain('chat-todo-item-');
    expect(html).not.toContain('Run the tests');
  });

  it('leaves the bar to the count alone when nothing is in progress', () => {
    const html = render([{ id: '1', content: 'Read the code', status: 'pending' }], true);
    expect(html).toContain('0 of 1 done');
    expect(html).not.toContain('Read the code');
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

  it('shows the activeForm of the current item on the bar', () => {
    const list = todos.map(todo => (todo.status === 'in_progress' ? { ...todo, activeForm: 'Writing the fix' } : todo));
    expect(render(list, true)).toContain('Writing the fix');
  });

  it('leaves cancelled items out of n/m', () => {
    const list: PlanItem[] = [
      { id: '1', content: 'Read the code', status: 'completed' },
      { id: '2', content: 'Old idea', status: 'cancelled' },
      { id: '3', content: 'Run the tests', status: 'pending' },
    ];
    expect(render(list, true)).toContain('1 of 2 done');
  });

  it('hides an all-cancelled plan, whatever the turn', () => {
    const list: PlanItem[] = [{ id: '1', content: 'Old idea', status: 'cancelled' }];
    expect(render(list, false)).toBe('');
    expect(render(list, true)).toBe('');
  });

  it('lists a cancelled item struck through, and the current item by its activeForm', async () => {
    const list: PlanItem[] = [
      { id: '1', content: 'Old idea', status: 'cancelled' },
      { id: '2', content: 'Write the fix', activeForm: 'Writing the fix', status: 'in_progress' },
    ];
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<TodoPanel todos={list} turnOpen />));
    await act(async () => host.querySelector<HTMLElement>('[data-testid="chat-todo-toggle"]')?.click());
    const cancelled = host.querySelector('[data-testid="chat-todo-item-cancelled"]');
    expect(cancelled).not.toBeNull();
    expect(getComputedStyle(cancelled!.querySelector('[data-testid="chat-todo-text"]')!).textDecoration).toContain(
      'line-through'
    );
    expect(host.querySelector('[data-testid="chat-todo-item-in_progress"]')?.textContent).toContain('Writing the fix');
    await act(async () => root.unmount());
  });
});
