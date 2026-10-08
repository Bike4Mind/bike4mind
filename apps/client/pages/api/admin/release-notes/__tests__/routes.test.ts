// @vitest-environment node
/**
 * Route tests for the admin release-notes API. `baseApi` is stubbed to a method dispatcher; the
 * repository mutations themselves (editedAt stamping, emptyItems rules) are covered in ReleaseNoteModel.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const m = vi.hoisted(() => ({
  adminList: vi.fn(),
  edit: vi.fn(),
  hide: vi.fn(),
  unhide: vi.fn(),
  publishNow: vi.fn(),
  getSettings: vi.fn(),
  invalidate: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    for (const method of ['get', 'post', 'patch', 'put']) {
      (chain as unknown as Record<string, unknown>)[method] = (fn: (typeof handlers)[string]) => {
        handlers[method.toUpperCase()] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  releaseNoteRepository: {
    adminList: m.adminList,
    edit: m.edit,
    hide: m.hide,
    unhide: m.unhide,
    publishNow: m.publishNow,
  },
}));
vi.mock('@bike4mind/database/infra', () => ({ AdminSettings: { findOneAndUpdate: m.upsert } }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: m.getSettings, invalidateSettingsCache: m.invalidate }));

const { default: listHandler } = await import('@pages/api/admin/release-notes/index');
const { default: editHandler } = await import('@pages/api/admin/release-notes/[id]');
const { default: statusHandler } = await import('@pages/api/admin/release-notes/[id]/status');
const { default: configHandler } = await import('@pages/api/admin/release-notes/config');

const ID = '64b7f0c2a1b2c3d4e5f60718';
const note = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  releaseTag: 'v1.2.3',
  deployedSha: 'abc123',
  deployedAt: new Date('2026-01-01T00:00:00Z'),
  headline: 'Faster search',
  summary: 'Search is faster.',
  items: [{ category: 'improved', text: 'Search is faster', importance: 1, sourcePrs: [12] }],
  status: 'scheduled',
  publishAt: new Date('2099-01-01T00:00:00Z'),
  editedAt: new Date('2026-01-02T00:00:00Z'),
  ...overrides,
});

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
async function call(
  handler: unknown,
  opts: { method: string; isAdmin?: boolean; query?: Record<string, string>; body?: unknown }
) {
  const { req, res } = createMocks({
    method: opts.method as 'GET',
    query: opts.query ?? {},
    body: opts.body as object,
  });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: opts.isAdmin ?? true }, logger: { warn: vi.fn() } });
  const error = await (handler as Handler)(req, res).then(
    () => undefined,
    (e: { statusCode: number; message: string }) => e
  );
  return { error, status: res._getStatusCode(), body: error ? undefined : res._getJSONData() };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettings.mockResolvedValue({ releaseNotesConfig: { enabled: true, denylist: ['Acme Corp'], embargoHours: 6 } });
});

describe('admin guard', () => {
  it.each([
    ['list', listHandler, 'GET', {}],
    ['edit', editHandler, 'PATCH', { headline: 'x' }],
    ['status', statusHandler, 'POST', { action: 'hide' }],
    ['config get', configHandler, 'GET', undefined],
    ['config put', configHandler, 'PUT', { enabled: true }],
  ])('%s answers 403 to a non-admin and touches nothing', async (_name, handler, method, body) => {
    const { error } = await call(handler, { method, isAdmin: false, query: { id: ID }, body });
    expect(error?.statusCode).toBe(403);
    for (const fn of [m.adminList, m.edit, m.hide, m.upsert]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/release-notes', () => {
  it('lists by status and returns a cursor scoped to that status', async () => {
    m.adminList.mockResolvedValue({ items: [note()], hasMore: true });
    const first = await call(listHandler, { method: 'GET', query: { status: 'scheduled', limit: '1' } });
    expect(first.body.data[0]).toMatchObject({ id: ID, state: 'scheduled', editedAt: '2026-01-02T00:00:00.000Z' });
    expect(m.adminList).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'scheduled', limit: 1, after: undefined })
    );

    const next = await call(listHandler, {
      method: 'GET',
      query: { status: 'scheduled', cursor: first.body.next_cursor },
    });
    expect(next.error).toBeUndefined();
    expect(m.adminList).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { publishAt: new Date('2099-01-01T00:00:00Z'), id: ID } })
    );

    const foreign = await call(listHandler, {
      method: 'GET',
      query: { status: 'hidden', cursor: first.body.next_cursor },
    });
    expect(foreign.error?.statusCode).toBe(422);
  });

  it.each([{ status: 'live' }, { limit: '0' }, { limit: '101' }, { limit: 'abc' }])(
    'rejects %o with 400',
    async query => {
      const { error } = await call(listHandler, { method: 'GET', query });
      expect(error?.statusCode).toBe(400);
    }
  );
});

describe('PATCH /api/admin/release-notes/[id]', () => {
  it('scrubs internal references before saving', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note() });
    const { body } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: {
        headline: 'Faster search (#4567)',
        items: [{ category: 'new', text: 'New thing', importance: 2, sourcePrs: [] }],
      },
    });
    expect(m.edit).toHaveBeenCalledWith(ID, {
      headline: 'Faster search',
      items: [{ category: 'new', text: 'New thing', importance: 2, sourcePrs: [] }],
    });
    expect(body.id).toBe(ID);
  });

  it.each([
    ['empty headline', { headline: '' }],
    ['non-array items', { items: 'x' }],
    ['no fields', {}],
    ['unknown field', { status: 'hidden' }],
    ['denylisted summary', { summary: 'Built for ACME corp.' }],
    ['denylisted item', { items: [{ category: 'new', text: 'acme-corp import', importance: 1, sourcePrs: [] }] }],
    ['headline that is only a ref', { headline: '#4567' }],
  ])('rejects %s with 400', async (_name, body) => {
    const { error } = await call(editHandler, { method: 'PATCH', query: { id: ID }, body });
    expect(error?.statusCode).toBe(400);
    expect(m.edit).not.toHaveBeenCalled();
  });

  it('rejects a bad id with 400 and maps notFound to 404 and emptyItems to 400', async () => {
    expect(
      (await call(editHandler, { method: 'PATCH', query: { id: 'nope' }, body: { headline: 'x' } })).error?.statusCode
    ).toBe(400);
    m.edit.mockResolvedValueOnce({ kind: 'notFound' });
    expect(
      (await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { headline: 'x' } })).error?.statusCode
    ).toBe(404);
    m.edit.mockResolvedValueOnce({ kind: 'emptyItems' });
    expect(
      (await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { items: [] } })).error?.statusCode
    ).toBe(400);
  });
});

describe('POST /api/admin/release-notes/[id]/status', () => {
  it.each([
    ['hide', m.hide],
    ['unhide', m.unhide],
    ['publishNow', m.publishNow],
  ])('%s calls the matching repository mutation', async (action, fn) => {
    fn.mockResolvedValue({ kind: 'ok', note: note({ status: action === 'hide' ? 'hidden' : 'scheduled' }) });
    const { body } = await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action } });
    expect(fn).toHaveBeenCalledWith(ID);
    expect(body.state).toBe(action === 'hide' ? 'hidden' : 'scheduled');
  });

  it('answers 400 when unhiding a note with no items, 404 when missing, 400 for an unknown action', async () => {
    m.unhide.mockResolvedValueOnce({ kind: 'emptyItems' });
    expect(
      (await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'unhide' } })).error?.statusCode
    ).toBe(400);
    m.publishNow.mockResolvedValueOnce({ kind: 'notFound' });
    expect(
      (await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'publishNow' } })).error
        ?.statusCode
    ).toBe(404);
    expect(
      (await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'delete' } })).error?.statusCode
    ).toBe(400);
  });
});

describe('/api/admin/release-notes/config', () => {
  it('GET parses a stored JSON string and flags a malformed value', async () => {
    m.getSettings.mockResolvedValueOnce({ releaseNotesConfig: JSON.stringify({ enabled: true, embargoHours: 3 }) });
    expect((await call(configHandler, { method: 'GET' })).body).toMatchObject({
      config: { enabled: true, embargoHours: 3, denylist: [] },
      malformed: false,
    });
    m.getSettings.mockResolvedValueOnce({ releaseNotesConfig: '{not json' });
    expect((await call(configHandler, { method: 'GET' })).body).toMatchObject({
      config: { enabled: false },
      malformed: true,
    });
  });

  it('a partial PUT keeps every stored field it does not name', async () => {
    const { body } = await call(configHandler, { method: 'PUT', body: { enabled: false } });
    const saved = { enabled: false, modelId: 'gpt-4o-mini', embargoHours: 6, denylist: ['Acme Corp'] };
    expect(m.upsert).toHaveBeenCalledWith(
      { settingName: 'releaseNotesConfig' },
      { $set: { settingValue: saved } },
      expect.objectContaining({ upsert: true })
    );
    expect(m.invalidate).toHaveBeenCalledWith('releaseNotesConfig');
    expect(body.config).toEqual(saved);
  });

  it.each([{ embargoHours: 169 }, { embargoHours: -1 }, { denylist: 'x' }, { surprise: true }])(
    'PUT rejects %o with 400',
    async body => {
      const { error } = await call(configHandler, { method: 'PUT', body });
      expect(error?.statusCode).toBe(400);
      expect(m.upsert).not.toHaveBeenCalled();
    }
  );
});
