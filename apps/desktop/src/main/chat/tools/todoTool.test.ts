import { describe, expect, it } from 'vitest';
import { findTool, toolsForRequest } from './registry';
import { todoWrite } from './todoTool';

const context = { roots: ['/tmp'], signal: new AbortController().signal };

describe('todo_write', () => {
  it('summarises the plan for the model', async () => {
    const result = await todoWrite.run(
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'pending' },
        ],
      },
      context
    );
    expect(result).toBe('Plan updated: 1 done, 1 in progress, 1 pending.');
  });

  it('tells the model when more than one item is in progress', async () => {
    const result = await todoWrite.run(
      {
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      },
      context
    );
    expect(result).toContain('More than one is in progress');
  });

  it('counts cancelled items and offers activeForm and cancelled in its schema', async () => {
    const result = await todoWrite.run(
      { todos: [{ content: 'a', status: 'cancelled', activeForm: 'Doing a' }] },
      context
    );
    expect(result).toBe('Plan updated: 0 done, 0 in progress, 0 pending, 1 cancelled.');
    const item = (
      todoWrite.schema.parameters as unknown as { properties: { todos: { items: { properties: object } } } }
    ).properties.todos.items.properties;
    expect(Object.keys(item)).toEqual(expect.arrayContaining(['activeForm', 'status']));
    expect(JSON.stringify(item)).toContain('cancelled');
  });

  it('refuses a malformed list so the model corrects it', async () => {
    await expect(todoWrite.run({ todos: [{ content: 'a', status: 'soon' }] }, context)).rejects.toThrow(
      /status "soon"/
    );
  });

  it('needs no approval and is offered with or without a granted folder', () => {
    expect(todoWrite.approval).toBeUndefined();
    expect(findTool('todo_write')).toBe(todoWrite);
    const names = (roots: string[]) =>
      toolsForRequest({ roots, media: false, host: false }).map(tool => tool.toolSchema.name);
    expect(names(['/tmp'])).toContain('todo_write');
    expect(names([])).toContain('todo_write');
  });
});
