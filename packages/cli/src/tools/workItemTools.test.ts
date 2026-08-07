import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IWorkItem } from '@bike4mind/common';
import { createWorkItemTools } from './workItemTools';
import type { WorkItemsClient } from '../api/WorkItemsClient';

const makeItem = (overrides: Partial<IWorkItem> = {}): IWorkItem => ({
  id: 'a1',
  userId: 'u1',
  title: 'Ship the thing',
  status: 'open',
  dependencies: [],
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
});

const makeClient = () => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  ready: vi.fn(),
  graph: vi.fn(),
});

type FakeClient = ReturnType<typeof makeClient>;

let client: FakeClient;
let tools: Record<string, ICompletionOptionTools>;

const run = (name: string, args: unknown = {}) => tools[name].toolFn(args) as Promise<string>;

beforeEach(() => {
  client = makeClient();
  tools = Object.fromEntries(
    createWorkItemTools(client as unknown as WorkItemsClient).map(tool => [tool.toolSchema.name, tool])
  );
});

describe('createWorkItemTools', () => {
  it('registers exactly the six documented tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'read_prior_todos',
      'work_item_close',
      'work_item_create',
      'work_item_graph',
      'work_item_ready',
      'work_item_update',
    ]);
  });
});

describe('read_prior_todos', () => {
  it('defaults to unfinished statuses and renders each item', async () => {
    client.list.mockResolvedValue({
      data: [makeItem(), makeItem({ id: 'b2', status: 'in_progress' })],
      hasMore: false,
      total: 2,
    });

    const output = await run('read_prior_todos');

    expect(client.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['open', 'in_progress', 'blocked'], limit: 50 })
    );
    expect(output).toContain('[ ] a1 Ship the thing');
    expect(output).toContain('[~] b2 Ship the thing');
  });

  it('passes an explicit status filter through', async () => {
    client.list.mockResolvedValue({ data: [], hasMore: false, total: 0 });

    await run('read_prior_todos', { status: ['closed'] });

    expect(client.list).toHaveBeenCalledWith(expect.objectContaining({ status: ['closed'] }));
  });

  it('rejects an unknown status', async () => {
    await expect(run('read_prior_todos', { status: ['nope'] })).rejects.toThrow(/status must be one of/);
  });

  it('clamps limit to the maximum', async () => {
    client.list.mockResolvedValue({ data: [], hasMore: false, total: 0 });

    await run('read_prior_todos', { limit: 10_000 });

    expect(client.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it('reports truncation when more items exist', async () => {
    client.list.mockResolvedValue({ data: [makeItem()], hasMore: true, total: 9 });

    expect(await run('read_prior_todos')).toContain('showing 1 of 9');
  });

  it('says so when there is nothing outstanding', async () => {
    client.list.mockResolvedValue({ data: [], hasMore: false, total: 0 });

    expect(await run('read_prior_todos')).toBe('No unfinished work items from prior sessions.');
  });

  it('degrades to a message when the backend is unreachable', async () => {
    client.list.mockRejectedValue(new Error('ECONNREFUSED'));

    const output = await run('read_prior_todos');

    expect(output).toContain('backend unreachable');
    expect(output).toContain('ECONNREFUSED');
  });
});

describe('backend error reporting', () => {
  it('reports a server rejection verbatim so the agent can act on it', async () => {
    const rejection = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { message: 'Those dependencies would create a cycle' } },
    });
    client.create.mockRejectedValue(rejection);

    const output = await run('work_item_create', { title: 'Ship it', dependencies: ['b2'] });

    expect(output).toContain('HTTP 400');
    expect(output).toContain('Those dependencies would create a cycle');
    expect(output).not.toContain('offline');
  });

  it('falls back to the axios message when the body carries no message', async () => {
    client.close.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: '' } })
    );

    const output = await run('work_item_close', { id: 'a1' });

    expect(output).toContain('HTTP 404');
    expect(output).toContain('Request failed with status code 404');
  });

  it('treats a response-less failure as offline', async () => {
    client.graph.mockRejectedValue(new Error('socket hang up'));

    expect(await run('work_item_graph')).toContain('offline');
  });
});

describe('work_item_create', () => {
  it('creates with only the fields provided', async () => {
    client.create.mockResolvedValue(makeItem());

    const output = await run('work_item_create', { title: '  Ship the thing  ' });

    expect(client.create).toHaveBeenCalledWith({ title: 'Ship the thing' });
    expect(output).toContain('Created work item');
  });

  it('forwards description, status and dependencies', async () => {
    client.create.mockResolvedValue(makeItem({ dependencies: ['b2'] }));

    const output = await run('work_item_create', {
      title: 'Ship the thing',
      description: 'context',
      status: 'blocked',
      dependencies: ['b2'],
    });

    expect(client.create).toHaveBeenCalledWith({
      title: 'Ship the thing',
      description: 'context',
      status: 'blocked',
      dependencies: ['b2'],
    });
    expect(output).toContain('depends on: b2');
  });

  it('requires a non-empty title', async () => {
    await expect(run('work_item_create', { title: '   ' })).rejects.toThrow(/title must be a non-empty string/);
  });

  it('rejects non-string dependency ids', async () => {
    await expect(run('work_item_create', { title: 'x', dependencies: [1] })).rejects.toThrow(/dependencies must be/);
  });
});

describe('work_item_update', () => {
  it('sends only the provided fields', async () => {
    client.update.mockResolvedValue(makeItem({ status: 'in_progress' }));

    await run('work_item_update', { id: 'a1', status: 'in_progress' });

    expect(client.update).toHaveBeenCalledWith('a1', { status: 'in_progress' });
  });

  it('refuses an update with no changes', async () => {
    await expect(run('work_item_update', { id: 'a1' })).rejects.toThrow(/at least one of/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('requires an id', async () => {
    await expect(run('work_item_update', { status: 'closed' })).rejects.toThrow(/id must be a non-empty string/);
  });

  it('allows clearing the description with an empty string', async () => {
    client.update.mockResolvedValue(makeItem());

    await run('work_item_update', { id: 'a1', description: '' });

    expect(client.update).toHaveBeenCalledWith('a1', { description: '' });
  });
});

describe('work_item_close', () => {
  it('closes by id', async () => {
    client.close.mockResolvedValue(makeItem({ status: 'closed' }));

    const output = await run('work_item_close', { id: 'a1' });

    expect(client.close).toHaveBeenCalledWith('a1');
    expect(output).toContain('[x] a1');
  });

  it('requires an id', async () => {
    await expect(run('work_item_close', {})).rejects.toThrow(/id must be a non-empty string/);
  });
});

describe('work_item_ready', () => {
  it('lists ready items', async () => {
    client.ready.mockResolvedValue([makeItem()]);

    expect(await run('work_item_ready')).toContain('[ ] a1 Ship the thing');
  });

  it('says so when nothing is actionable', async () => {
    client.ready.mockResolvedValue([]);

    expect(await run('work_item_ready')).toBe('No work items are ready to start.');
  });
});

describe('work_item_graph', () => {
  it('renders nodes with their outgoing dependency edges', async () => {
    client.graph.mockResolvedValue({
      nodes: [
        { id: 'a1', title: 'First', status: 'open' },
        { id: 'b2', title: 'Second', status: 'closed' },
      ],
      edges: [{ from: 'a1', to: 'b2' }],
      cycles: [],
    });

    const output = await run('work_item_graph');

    expect(output).toContain('2 item(s), 1 dependency edge(s)');
    expect(output).toContain('[ ] a1 First -> b2');
    expect(output).toContain('[x] b2 Second');
  });

  it('warns about cycles left by direct database writes', async () => {
    client.graph.mockResolvedValue({
      nodes: [
        { id: 'a1', title: 'First', status: 'open' },
        { id: 'b2', title: 'Second', status: 'open' },
      ],
      edges: [
        { from: 'a1', to: 'b2' },
        { from: 'b2', to: 'a1' },
      ],
      cycles: ['a1', 'b2'],
    });

    expect(await run('work_item_graph')).toContain('WARNING: dependency cycle involving: a1, b2');
  });

  it('handles an empty graph', async () => {
    client.graph.mockResolvedValue({ nodes: [], edges: [], cycles: [] });

    expect(await run('work_item_graph')).toBe('No work items yet.');
  });
});
