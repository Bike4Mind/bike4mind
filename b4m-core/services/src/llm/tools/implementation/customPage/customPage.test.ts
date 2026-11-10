import { describe, it, expect, vi } from 'vitest';
import { pageGetStateTool, pageUpdateStateTool, pageSetWidgetTool } from './index';
import type { CustomPageToolPort } from './port';
import type { ToolContext } from '../../base/types';
import { b4mTools } from '../../index';
import { pageError } from '../../../../customPageService/ports';
import { CUSTOM_PAGE_TOOL_NAMES } from '@bike4mind/common';

const PAGE = {
  id: 'p1',
  name: 'Daily menu',
  state: { ingredients: ['eggs'] },
  widgets: [{ id: 'shopping-list', type: 'checklist' as const, items: [{ id: 'a', label: 'rice', checked: false }] }],
};

function makePort(overrides: Partial<CustomPageToolPort> = {}): CustomPageToolPort {
  return {
    findForSession: vi.fn().mockResolvedValue(PAGE),
    patchState: vi.fn().mockResolvedValue({ ok: true, page: { ...PAGE, state: { ingredients: ['eggs', 'rice'] } } }),
    setWidget: vi.fn().mockResolvedValue({ ok: true, page: PAGE }),
    removeWidget: vi.fn().mockResolvedValue({ ok: true, page: { ...PAGE, widgets: [] } }),
    ...overrides,
  };
}

function makeContext(port?: CustomPageToolPort, sessionId: string | null = 'session-1'): ToolContext {
  return {
    userId: 'user-1',
    sessionId: sessionId ?? undefined,
    db: port ? { customPages: port } : {},
  } as unknown as ToolContext;
}

const run = (tool: typeof pageGetStateTool, context: ToolContext, params?: unknown) =>
  tool.implementation(context, {}).toolFn(params);

describe('page tools registration', () => {
  it('registers every custom page tool name', () => {
    for (const name of CUSTOM_PAGE_TOOL_NAMES) expect(b4mTools).toHaveProperty(name);
  });
});

describe('page tools without a usable page', () => {
  it.each([
    ['page_get_state', pageGetStateTool, undefined],
    ['page_update_state', pageUpdateStateTool, { patch: { a: 1 } }],
    ['page_set_widget', pageSetWidgetTool, { action: 'remove', widgetId: 'x' }],
  ])('%s reports a missing port', async (_name, tool, params) => {
    expect(await run(tool, makeContext(undefined), params)).toMatch(/not configured/);
  });

  it.each([
    ['page_get_state', pageGetStateTool, undefined],
    ['page_update_state', pageUpdateStateTool, { patch: { a: 1 } }],
    ['page_set_widget', pageSetWidgetTool, { action: 'remove', widgetId: 'x' }],
  ])('%s refuses a forged session with no page and changes nothing', async (_name, tool, params) => {
    const port = makePort({ findForSession: vi.fn().mockResolvedValue(null) });
    const result = await run(tool, makeContext(port), params);
    expect(result).toMatch(/no page for this session/);
    expect(port.patchState).not.toHaveBeenCalled();
    expect(port.setWidget).not.toHaveBeenCalled();
    expect(port.removeWidget).not.toHaveBeenCalled();
  });

  it('refuses when the context has no session id', async () => {
    const port = makePort();
    expect(await run(pageGetStateTool, makeContext(port, null))).toMatch(/no page is attached/);
    expect(port.findForSession).not.toHaveBeenCalled();
  });
});

describe('page_get_state', () => {
  it('returns name, state and a widget summary scoped to the session and user', async () => {
    const port = makePort();
    const result = JSON.parse((await run(pageGetStateTool, makeContext(port))) as string);
    expect(port.findForSession).toHaveBeenCalledWith('session-1', 'user-1');
    expect(result).toEqual({
      name: 'Daily menu',
      state: { ingredients: ['eggs'] },
      widgets: [{ id: 'shopping-list', type: 'checklist', itemCount: 1 }],
    });
  });
});

describe('page_update_state', () => {
  it('applies the patch to the resolved page id', async () => {
    const port = makePort();
    const result = await run(pageUpdateStateTool, makeContext(port), { patch: { ingredients: ['eggs', 'rice'] } });
    expect(port.patchState).toHaveBeenCalledWith({
      pageId: 'p1',
      userId: 'user-1',
      patch: { ingredients: ['eggs', 'rice'] },
    });
    expect(result).toMatch(/State updated/);
    expect(result).toContain('rice');
  });

  it('rejects a non-object patch before touching the port', async () => {
    const port = makePort();
    expect(await run(pageUpdateStateTool, makeContext(port), { patch: [1] })).toMatch(/must be a JSON object/);
    expect(port.findForSession).not.toHaveBeenCalled();
  });

  it('relays a service failure as text', async () => {
    const port = makePort({ patchState: vi.fn().mockResolvedValue(pageError('state_too_large', 'Too big')) });
    expect(await run(pageUpdateStateTool, makeContext(port), { patch: { a: 1 } })).toBe('Error: Too big');
  });
});

describe('page_set_widget', () => {
  it('upserts a widget', async () => {
    const port = makePort();
    const widget = { type: 'markdown', id: 'recipe', markdown: '# Shakshuka' };
    const result = await run(pageSetWidgetTool, makeContext(port), { action: 'upsert', widget });
    expect(port.setWidget).toHaveBeenCalledWith({ pageId: 'p1', userId: 'user-1', widget });
    expect(result).toMatch(/Widget "recipe" saved/);
  });

  it('returns validation issues to the model for an invalid widget', async () => {
    const port = makePort({
      setWidget: vi.fn().mockResolvedValue(pageError('invalid', 'Invalid widget', ['items: Required'])),
    });
    const result = await run(pageSetWidgetTool, makeContext(port), {
      action: 'upsert',
      widget: { type: 'checklist', id: 'x' },
    });
    expect(result).toContain('Invalid widget');
    expect(result).toContain('items: Required');
  });

  it('removes a widget by id', async () => {
    const port = makePort();
    const result = await run(pageSetWidgetTool, makeContext(port), { action: 'remove', widgetId: 'shopping-list' });
    expect(port.removeWidget).toHaveBeenCalledWith({ pageId: 'p1', userId: 'user-1', widgetId: 'shopping-list' });
    expect(result).toMatch(/removed/);
  });

  it('requires widgetId for remove and widget for upsert', async () => {
    const port = makePort();
    expect(await run(pageSetWidgetTool, makeContext(port), { action: 'remove' })).toMatch(/widgetId/);
    expect(await run(pageSetWidgetTool, makeContext(port), { action: 'upsert' })).toMatch(/`widget` is required/);
    expect(await run(pageSetWidgetTool, makeContext(port), { action: 'nope' })).toMatch(/must be/);
  });
});
