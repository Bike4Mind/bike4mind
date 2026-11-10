import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const m = vi.hoisted(() => ({
  listOwned: vi.fn(),
  findOwned: vi.fn(),
  updateMetaOwned: vi.fn(),
  softDeleteOwned: vi.fn(),
  createPage: vi.fn(),
  patchState: vi.fn(),
  setWidget: vi.fn(),
  removeWidget: vi.fn(),
  toggleChecklistItem: vi.fn(),
  baseApiOptions: [] as unknown[],
}));

type Fn = (req: unknown, res: unknown) => unknown;

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    m.baseApiOptions.push(options);
    const h: Record<string, Fn> = {};
    const verb =
      (name: string) =>
      (...fns: Fn[]) => ((h[name] = fns[fns.length - 1]), chain);
    const chain: Fn & Record<string, unknown> = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: verb('GET'),
        post: verb('POST'),
        put: verb('PUT'),
        patch: verb('PATCH'),
        delete: verb('DELETE'),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => null }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => null }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => null }));
vi.mock('@bike4mind/database', () => ({
  customPageRepository: {
    listOwned: (...a: unknown[]) => m.listOwned(...a),
    findOwned: (...a: unknown[]) => m.findOwned(...a),
    updateMetaOwned: (...a: unknown[]) => m.updateMetaOwned(...a),
    softDeleteOwned: (...a: unknown[]) => m.softDeleteOwned(...a),
  },
  sessionRepository: { name: 'sessions' },
  projectRepository: {},
  fabFileRepository: {},
  agentRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  customPageService: {
    createPage: (...a: unknown[]) => m.createPage(...a),
    patchState: (...a: unknown[]) => m.patchState(...a),
    setWidget: (...a: unknown[]) => m.setWidget(...a),
    removeWidget: (...a: unknown[]) => m.removeWidget(...a),
    toggleChecklistItem: (...a: unknown[]) => m.toggleChecklistItem(...a),
  },
}));

import listHandler from '../index';
import pageHandler from '../[id]/index';
import stateHandler from '../[id]/state';
import widgetHandler from '../[id]/widgets/[widgetId]/index';
import itemHandler from '../[id]/widgets/[widgetId]/items/[itemId]';

const PAGE_ID = '6a1fb3d3e310bb516192e8c8';
const USER = { id: 'u1' };
const PAGE = {
  id: PAGE_ID,
  userId: 'u1',
  name: 'Daily menu',
  orchestratorSessionId: 's1',
  version: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  state: {},
  widgets: [],
};
const PAGE_JSON = JSON.parse(JSON.stringify(PAGE));

const run = async (handler: unknown, method: string, query: Record<string, string> = {}, body: unknown = {}) => {
  const { req, res } = createMocks({ method: method as 'GET', query, body: body as Record<string, unknown> });
  (req as unknown as { user: typeof USER }).user = USER;
  await (handler as Fn)(req, res);
  return res;
};

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
});

describe('route gating', () => {
  it('declares every handler jwtOnly so API keys never reach it', () => {
    expect(m.baseApiOptions).toHaveLength(5);
    for (const options of m.baseApiOptions) expect(options).toMatchObject({ auth: 'jwtOnly' });
  });
});

describe('/api/pages', () => {
  it('lists the caller pages', async () => {
    const { state: _state, widgets: _widgets, ...summary } = PAGE;
    m.listOwned.mockResolvedValue([summary]);
    const res = await run(listHandler, 'GET');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ pages: [JSON.parse(JSON.stringify(summary))] });
    expect(m.listOwned).toHaveBeenCalledWith('u1');
  });

  it('creates a page bound to the caller', async () => {
    m.createPage.mockResolvedValue(PAGE);
    const res = await run(listHandler, 'POST', {}, { name: '  Daily menu ', userId: 'evil' });
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ page: PAGE_JSON });
    const [user, input, adapters] = m.createPage.mock.calls[0];
    expect(user).toBe(USER);
    expect(input).toEqual({ name: 'Daily menu' });
    expect(adapters.db).toHaveProperty('customPages');
    expect(adapters.db).toHaveProperty('sessions');
  });

  it('rejects an empty name', async () => {
    const res = await run(listHandler, 'POST', {}, { name: '' });
    expect(res._getStatusCode()).toBe(400);
    expect(m.createPage).not.toHaveBeenCalled();
  });
});

describe('/api/pages/[id]', () => {
  it('rejects an invalid id', async () => {
    const res = await run(pageHandler, 'GET', { id: 'nope' });
    expect(res._getStatusCode()).toBe(400);
    expect(m.findOwned).not.toHaveBeenCalled();
  });

  it('returns 404 for a page the caller does not own', async () => {
    m.findOwned.mockResolvedValue(null);
    const res = await run(pageHandler, 'GET', { id: PAGE_ID });
    expect(res._getStatusCode()).toBe(404);
    expect(m.findOwned).toHaveBeenCalledWith(PAGE_ID, 'u1');
  });

  it('returns the page', async () => {
    m.findOwned.mockResolvedValue(PAGE);
    const res = await run(pageHandler, 'GET', { id: PAGE_ID });
    expect(res._getJSONData()).toEqual({ page: PAGE_JSON });
  });

  it('updates meta fields only', async () => {
    m.updateMetaOwned.mockResolvedValue({ ...PAGE, name: 'Menu' });
    const res = await run(pageHandler, 'PATCH', { id: PAGE_ID }, { name: 'Menu', state: { hack: 1 } });
    expect(res._getStatusCode()).toBe(200);
    expect(m.updateMetaOwned).toHaveBeenCalledWith(PAGE_ID, 'u1', { name: 'Menu' });
  });

  it('soft-deletes with 204, 404 when missing', async () => {
    m.softDeleteOwned.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await run(pageHandler, 'DELETE', { id: PAGE_ID }))._getStatusCode()).toBe(204);
    expect((await run(pageHandler, 'DELETE', { id: PAGE_ID }))._getStatusCode()).toBe(404);
  });
});

describe('/api/pages/[id]/state', () => {
  it('passes the merge patch to the service', async () => {
    m.patchState.mockResolvedValue({ ok: true, page: PAGE });
    const res = await run(stateHandler, 'PATCH', { id: PAGE_ID }, { patch: { ingredients: ['eggs'] } });
    expect(res._getStatusCode()).toBe(200);
    expect(m.patchState).toHaveBeenCalledWith(
      { pageId: PAGE_ID, userId: 'u1', patch: { ingredients: ['eggs'] } },
      expect.anything()
    );
  });

  it('rejects a missing patch', async () => {
    const res = await run(stateHandler, 'PATCH', { id: PAGE_ID }, { ingredients: ['eggs'] });
    expect(res._getStatusCode()).toBe(400);
  });

  it('maps service errors to status codes', async () => {
    m.patchState.mockResolvedValue({ ok: false, code: 'state_too_large', message: 'too big' });
    const res = await run(stateHandler, 'PATCH', { id: PAGE_ID }, { patch: { a: 1 } });
    expect(res._getStatusCode()).toBe(413);
    expect(res._getJSONData()).toEqual({ error: 'too big', code: 'state_too_large' });
  });
});

describe('/api/pages/[id]/widgets/[widgetId]', () => {
  it('upserts a widget using the path id', async () => {
    m.setWidget.mockResolvedValue({ ok: true, page: PAGE });
    const body = { type: 'markdown', markdown: '# Recipe' };
    const res = await run(widgetHandler, 'PUT', { id: PAGE_ID, widgetId: 'recipe' }, body);
    expect(res._getStatusCode()).toBe(200);
    expect(m.setWidget).toHaveBeenCalledWith(
      { pageId: PAGE_ID, userId: 'u1', widget: { ...body, id: 'recipe' } },
      expect.anything()
    );
  });

  it('rejects a body id that differs from the path', async () => {
    const res = await run(widgetHandler, 'PUT', { id: PAGE_ID, widgetId: 'recipe' }, { id: 'other', type: 'markdown' });
    expect(res._getStatusCode()).toBe(400);
    expect(m.setWidget).not.toHaveBeenCalled();
  });

  it('rejects an invalid widget id', async () => {
    const res = await run(widgetHandler, 'DELETE', { id: PAGE_ID, widgetId: 'Bad Id' });
    expect(res._getStatusCode()).toBe(400);
  });

  it('returns issues for an invalid widget and 404 for a missing one on delete', async () => {
    m.setWidget.mockResolvedValue({
      ok: false,
      code: 'invalid',
      message: 'Invalid widget',
      issues: ['markdown: Required'],
    });
    const put = await run(widgetHandler, 'PUT', { id: PAGE_ID, widgetId: 'recipe' }, { type: 'markdown' });
    expect(put._getStatusCode()).toBe(400);
    expect(put._getJSONData().issues).toEqual(['markdown: Required']);

    m.removeWidget.mockResolvedValue({ ok: false, code: 'not_found', message: 'No widget' });
    expect((await run(widgetHandler, 'DELETE', { id: PAGE_ID, widgetId: 'recipe' }))._getStatusCode()).toBe(404);
  });
});

describe('/api/pages/[id]/widgets/[widgetId]/items/[itemId]', () => {
  it('toggles a checklist item', async () => {
    m.toggleChecklistItem.mockResolvedValue({ ok: true, page: PAGE });
    const res = await run(
      itemHandler,
      'PATCH',
      { id: PAGE_ID, widgetId: 'shopping-list', itemId: 'milk' },
      { checked: true }
    );
    expect(res._getStatusCode()).toBe(200);
    expect(m.toggleChecklistItem).toHaveBeenCalledWith(
      { pageId: PAGE_ID, userId: 'u1', widgetId: 'shopping-list', itemId: 'milk', checked: true },
      expect.anything()
    );
  });

  it('rejects a non-boolean checked', async () => {
    const res = await run(
      itemHandler,
      'PATCH',
      { id: PAGE_ID, widgetId: 'shopping-list', itemId: 'milk' },
      { checked: 'yes' }
    );
    expect(res._getStatusCode()).toBe(400);
  });
});
