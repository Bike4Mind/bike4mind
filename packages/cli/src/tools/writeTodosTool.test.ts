import { describe, it, expect, vi } from 'vitest';
import { createTodoStore, createWriteTodosTool } from './writeTodosTool.js';

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
    expect(result).toContain('1. \u{1F504} [in_progress] Write tests');
    expect(result).not.toContain('Notes:');
  });

  it('accepts description as a deprecated alias and reports it', async () => {
    const { store, result } = await run([{ description: 'Old shape', status: 'pending' }]);
    expect(store.todos[0].content).toBe('Old shape');
    expect(result).toContain('Notes:');
    expect(result).toContain('deprecated');
  });

  it('warns instead of throwing on multiple in_progress items', async () => {
    const { store, result } = await run([
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'in_progress' },
    ]);
    expect(store.todos.map(t => t.status)).toEqual(['in_progress', 'pending']);
    expect(result).toContain('only the first item per level stays in_progress');
  });

  it('clears the plan on an empty list and rejects a non-array', async () => {
    const { store } = await run([]);
    expect(store.todos).toEqual([]);
    await expect(run('nope')).rejects.toThrow('todos must be an array');
  });
});
