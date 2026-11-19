import { describe, it, expect, vi } from 'vitest';
import { createTodoStore, createWriteTodosTool, resetTodoStore } from './writeTodosTool.js';

async function run(todos: unknown) {
  const onUpdate = vi.fn();
  const store = createTodoStore(onUpdate);
  const result = await createWriteTodosTool(store).toolFn({ todos });
  return { store, onUpdate, result: String(result) };
}

describe('write_todos', () => {
  it('stores plan items and accepts activeForm', async () => {
    const { store, onUpdate, result } = await run([
      { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
    ]);
    expect(store.todos[0]).toMatchObject({ content: 'Write tests', activeForm: 'Writing tests' });
    expect(onUpdate).toHaveBeenCalledWith(store.todos);
    expect(result).toBe('Todo list updated successfully:\n\n1. \u{1F504} [in_progress] Write tests');
  });

  it('accepts description as a deprecated alias and reports it', async () => {
    const { store, result } = await run([{ description: 'Old shape', status: 'pending' }]);
    expect(store.todos[0].content).toBe('Old shape');
    expect(result).toBe(
      "Todo list updated successfully:\n\n1. \u2B1C [pending] Old shape\n\nNotes:\n- description is deprecated; use 'content'."
    );
  });

  it('warns instead of throwing on multiple in_progress items', async () => {
    const { store, result } = await run([
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'in_progress' },
    ]);
    expect(store.todos.map(t => t.status)).toEqual(['in_progress', 'pending']);
    expect(result).toContain('only the first item per level stays in_progress');
  });

  it('clears the plan on an explicit empty list', async () => {
    const { store, onUpdate, result } = await run([]);
    expect(store.todos).toEqual([]);
    expect(onUpdate).toHaveBeenCalledWith([]);
    expect(result).toBe('Todo list cleared.');
  });

  it('rejects a non-array', async () => {
    await expect(run('nope')).rejects.toThrow('todos must be an array');
  });

  it('keeps the prior plan when no item is usable', async () => {
    const onUpdate = vi.fn();
    const store = createTodoStore(onUpdate);
    const tool = createWriteTodosTool(store);
    await tool.toolFn({ todos: [{ content: 'Keep me', status: 'pending' }] });
    onUpdate.mockClear();
    const before = store.todos;

    await expect(tool.toolFn({ todos: [{ title: 'x', status: 'pending' }, null] })).rejects.toThrow(
      'no valid todo items; the existing list was kept'
    );
    expect(store.todos).toBe(before);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('resetTodoStore empties the plan and notifies', () => {
    const onUpdate = vi.fn();
    const store = createTodoStore(onUpdate);
    store.todos = [{ id: 'a', content: 'x', status: 'pending' }];
    resetTodoStore(store);
    expect(store.todos).toEqual([]);
    expect(onUpdate).toHaveBeenCalledWith([]);
  });
});
