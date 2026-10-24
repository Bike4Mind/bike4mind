// @vitest-environment node
/**
 * Route tests for the admin release-notes API. `baseApi` is stubbed to a method dispatcher; the
 * repository mutations themselves (editedAt stamping, emptyItems rules) are covered in ReleaseNoteModel.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { withholdAdminRole } from '@server/auth/apiKeyAdminScope';

const m = vi.hoisted(() => ({
  adminList: vi.fn(),
  edit: vi.fn(),
  attachVideo: vi.fn(),
  attachImage: vi.fn(),
  hide: vi.fn(),
  unhide: vi.fn(),
  publishNow: vi.fn(),
  findById: vi.fn(),
  findOne: vi.fn(),
  getSettings: vi.fn(),
  invalidate: vi.fn(),
  upsert: vi.fn(),
  findSetting: vi.fn(),
  audit: vi.fn(),
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
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  adminSettingsRepository: {},
  releaseNoteRepository: {
    adminList: m.adminList,
    edit: m.edit,
    attachVideo: m.attachVideo,
    attachImage: m.attachImage,
    hide: m.hide,
    unhide: m.unhide,
    publishNow: m.publishNow,
    findById: m.findById,
    findOne: m.findOne,
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: { findOneAndUpdate: m.upsert, findOne: () => ({ lean: () => m.findSetting() }) },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: m.audit }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: m.getSettings, invalidateSettingsCache: m.invalidate }));

const { default: listHandler } = await import('@pages/api/admin/release-notes/index');
const { default: editHandler } = await import('@pages/api/admin/release-notes/[id]');
const { default: statusHandler } = await import('@pages/api/admin/release-notes/[id]/status');
const { default: configHandler } = await import('@pages/api/admin/release-notes/config');

const ID = '64b7f0c2a1b2c3d4e5f60718';
const IMAGE = {
  landscapeUrl: 'https://d111.cloudfront.net/still.png',
  portraitUrl: 'https://d111.cloudfront.net/still-9x16.png',
};
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
  opts: {
    method: string;
    isAdmin?: boolean;
    withheldAdmin?: boolean;
    query?: Record<string, string>;
    body?: unknown;
    keyScopes?: string[];
  }
) {
  const { req, res } = createMocks({
    method: opts.method as 'GET',
    query: opts.query ?? {},
    body: opts.body as object,
  });
  const user = { id: 'admin-1', isAdmin: opts.isAdmin ?? true };
  Object.assign(req, { user: opts.withheldAdmin ? withholdAdminRole(user) : user, logger: { warn: vi.fn() } });
  if (opts.keyScopes) Object.assign(req, { apiKeyInfo: { scopes: opts.keyScopes } });
  const error = await (handler as Handler)(req, res).then(
    () => undefined,
    (e: { statusCode: number; message: string }) => e
  );
  return { error, status: res._getStatusCode(), body: error ? undefined : res._getJSONData() };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettings.mockResolvedValue({ releaseNotesConfig: { enabled: true, denylist: ['Acme Corp'], embargoHours: 6 } });
  m.findById.mockResolvedValue(note());
  m.findSetting.mockResolvedValue(null);
  m.audit.mockResolvedValue(null);
});

const MALFORMED = { releaseNotesConfig: '{not json' };

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

  it('flags a note that matches the current denylist, since the public feed withholds it', async () => {
    m.adminList.mockResolvedValue({ items: [note(), note({ headline: 'Now live for Acme Corp' })], hasMore: false });
    const { body } = await call(listHandler, { method: 'GET', query: { status: 'published' } });
    expect(body.data.map((n: { deniedTerm: string | null }) => n.deniedTerm)).toEqual([null, 'Acme Corp']);
  });

  it('lists the note for a tag in any state', async () => {
    m.findOne.mockResolvedValue(note({ releaseTag: 'v2026.10.20.1', status: 'hidden' }));
    const { body } = await call(listHandler, { method: 'GET', query: { tag: 'v2026.10.20.1', status: 'published' } });
    expect(m.findOne).toHaveBeenCalledWith({ releaseTag: 'v2026.10.20.1' });
    expect(m.adminList).not.toHaveBeenCalled();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ releaseTag: 'v2026.10.20.1', state: 'hidden' });
    expect(body.next_cursor).toBeNull();
  });

  it('returns an empty list for an unknown tag', async () => {
    m.findOne.mockResolvedValue(null);
    const { body } = await call(listHandler, { method: 'GET', query: { tag: 'v0' } });
    expect(body).toEqual({ data: [], next_cursor: null });
  });

  it('refuses a release-notes:write key that browses without a tag', async () => {
    const { error } = await call(listHandler, {
      method: 'GET',
      query: { status: 'hidden' },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(403);
    expect(m.adminList).not.toHaveBeenCalled();
  });

  it('lets a release-notes:write key look a note up by tag', async () => {
    m.findOne.mockResolvedValue(note({ releaseTag: 'v2026.10.20.1' }));
    const { error, body } = await call(listHandler, {
      method: 'GET',
      query: { tag: 'v2026.10.20.1' },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error).toBeUndefined();
    expect(body.data[0]).toMatchObject({ releaseTag: 'v2026.10.20.1' });
  });

  // apiKeyAuth withholds the admin role from a key without the admin scope, so the job key arrives with isAdmin false.
  it('lets a release-notes:write key without the admin role look a note up by tag', async () => {
    m.findOne.mockResolvedValue(note({ releaseTag: 'v2026.10.23.2' }));
    const { error, body } = await call(listHandler, {
      method: 'GET',
      withheldAdmin: true,
      query: { tag: 'v2026.10.23.2' },
      keyScopes: ['release-notes:write'],
    });
    expect(error).toBeUndefined();
    expect(body.data[0]).toMatchObject({ releaseTag: 'v2026.10.23.2' });
  });

  it('still refuses a release-notes:write key without the admin role that browses without a tag', async () => {
    const { error } = await call(listHandler, {
      method: 'GET',
      withheldAdmin: true,
      query: {},
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(403);
    expect(m.adminList).not.toHaveBeenCalled();
  });

  it('refuses a release-notes:write key whose owner is not an admin', async () => {
    const { error } = await call(listHandler, {
      method: 'GET',
      isAdmin: false,
      query: { tag: 'v2026.10.23.2' },
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(403);
    expect(m.findOne).not.toHaveBeenCalled();
  });

  it('leaves an admin:* key free to browse without a tag', async () => {
    m.adminList.mockResolvedValue({ items: [], hasMore: false });
    const { error } = await call(listHandler, { method: 'GET', query: {}, keyScopes: ['admin:*'] });
    expect(error).toBeUndefined();
    expect(m.adminList).toHaveBeenCalled();
  });

  it('refuses a tag with a cursor', async () => {
    const { error } = await call(listHandler, { method: 'GET', query: { tag: 'v0', cursor: 'abc' } });
    expect(error?.statusCode).toBe(422);
    expect(m.findOne).not.toHaveBeenCalled();
  });

  it.each([{ status: 'live' }, { limit: '0' }, { limit: '101' }, { limit: 'abc' }])(
    'rejects %o with 422, the same status as a bad cursor',
    async query => {
      const { error } = await call(listHandler, { method: 'GET', query });
      expect(error?.statusCode).toBe(422);
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

  it('sets a video and passes it to the edit', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note() });
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4', portraitUrl: null };
    const { error } = await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { video } });
    expect(error).toBeUndefined();
    expect(m.edit).toHaveBeenCalledWith(ID, { video });
  });

  it('clears the video with null', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note() });
    const { error } = await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { video: null } });
    expect(error).toBeUndefined();
    expect(m.edit).toHaveBeenCalledWith(ID, { video: null });
  });

  it('serves the stored video on the admin note', async () => {
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' };
    m.edit.mockResolvedValue({ kind: 'ok', note: note({ video }) });
    const { body } = await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { video } });
    expect(body.video).toEqual(video);
  });

  it('sets an image and passes it to the edit', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note({ image: IMAGE }) });
    const { status, body } = await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { image: IMAGE } });
    expect(status).toBe(200);
    expect(m.edit).toHaveBeenCalledWith(ID, { image: IMAGE });
    expect(body.image).toEqual(IMAGE);
  });

  it('clears the image with null', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note() });
    const { error } = await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { image: null } });
    expect(error).toBeUndefined();
    expect(m.edit).toHaveBeenCalledWith(ID, { image: null });
  });

  it('refuses an image on a disallowed host with 400', async () => {
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { image: { landscapeUrl: 'https://evil.example.com/s.png' } },
    });
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toContain('image.landscapeUrl');
    expect(m.edit).not.toHaveBeenCalled();
  });

  it('serves the stored image on the admin note, and null when there is none', async () => {
    m.findOne.mockResolvedValue(note({ image: IMAGE }));
    const withImage = await call(listHandler, { method: 'GET', query: { tag: 'v1.2.3' } });
    expect(withImage.body.data[0].image).toEqual(IMAGE);
    m.findOne.mockResolvedValue(note());
    const without = await call(listHandler, { method: 'GET', query: { tag: 'v1.2.3' } });
    expect(without.body.data[0].image).toBeNull();
  });

  it.each([
    ['empty headline', { headline: '' }],
    ['video on a disallowed host', { video: { landscapeUrl: 'https://evil.example.com/wide.mp4' } }],
    ['video over plain http', { video: { portraitUrl: 'http://d111.cloudfront.net/tall.mp4' } }],
    ['poster without its video', { video: { landscapePosterUrl: 'https://d111.cloudfront.net/p.png' } }],
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

  it('refuses with 409 while the stored config is malformed, since its default denylist is empty', async () => {
    m.getSettings.mockResolvedValueOnce(MALFORMED);
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { summary: 'Built for Acme Corp.' },
    });
    expect(error?.statusCode).toBe(409);
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

describe('PATCH /api/admin/release-notes/[id] with a release-notes:write key', () => {
  it('refuses any field but video or image with 403 and edits nothing', async () => {
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { headline: 'New headline', video: null },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(403);
    expect(error?.message).toContain('headline');
    expect(m.edit).not.toHaveBeenCalled();
    expect(m.attachVideo).not.toHaveBeenCalled();
    expect(m.attachImage).not.toHaveBeenCalled();
  });

  it('sets the video for a key without the admin role, as apiKeyAuth hands it over', async () => {
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' };
    m.attachVideo.mockResolvedValue({ kind: 'ok', note: note({ video, editedAt: null }) });
    const { error, status } = await call(editHandler, {
      method: 'PATCH',
      withheldAdmin: true,
      query: { id: ID },
      body: { video },
      keyScopes: ['release-notes:write'],
    });
    expect(error).toBeUndefined();
    expect(status).toBe(200);
    expect(m.attachVideo).toHaveBeenCalledWith(ID, video);
  });

  it('refuses a release-notes:write key whose owner is not an admin', async () => {
    const { error } = await call(editHandler, {
      method: 'PATCH',
      isAdmin: false,
      query: { id: ID },
      body: { video: { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' } },
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(403);
    expect(m.attachVideo).not.toHaveBeenCalled();
  });

  it('sets the video through attachVideo, which leaves editedAt alone, never through edit', async () => {
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' };
    m.attachVideo.mockResolvedValue({ kind: 'ok', note: note({ video, editedAt: null }) });
    const { error, status, body } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { video },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error).toBeUndefined();
    expect(status).toBe(200);
    expect(m.attachVideo).toHaveBeenCalledWith(ID, video);
    expect(m.edit).not.toHaveBeenCalled();
    expect(body.editedAt).toBeNull();
  });

  it('answers 404 when the note to attach a video to is gone', async () => {
    m.attachVideo.mockResolvedValue({ kind: 'notFound' });
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { video: null },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(404);
  });

  it('sets the image through attachImage, which leaves editedAt alone, never through edit', async () => {
    m.attachImage.mockResolvedValue({ kind: 'ok', note: note({ image: IMAGE, editedAt: null }) });
    const { status, body } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { image: IMAGE },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(status).toBe(200);
    expect(m.attachImage).toHaveBeenCalledWith(ID, IMAGE);
    expect(m.edit).not.toHaveBeenCalled();
    expect(body.editedAt).toBeNull();
  });

  it('refuses video and image in one request with 400 and writes nothing', async () => {
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { video: null, image: IMAGE },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(400);
    expect(error?.message).toContain('send one per request');
    for (const fn of [m.attachVideo, m.attachImage, m.edit]) expect(fn).not.toHaveBeenCalled();
  });

  it('answers 404 when the note to attach an image to is gone', async () => {
    m.attachImage.mockResolvedValue({ kind: 'notFound' });
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { image: IMAGE },
      withheldAdmin: true,
      keyScopes: ['release-notes:write'],
    });
    expect(error?.statusCode).toBe(404);
  });

  it('keeps a session admin video edit on edit, which marks the note edited', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note({ video: null }) });
    await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { video: null } });
    expect(m.edit).toHaveBeenCalledWith(ID, { video: null });
    expect(m.attachVideo).not.toHaveBeenCalled();
  });

  it('leaves an admin:* key free to edit the text', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note() });
    const { error } = await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { headline: 'New headline' },
      keyScopes: ['admin:*'],
    });
    expect(error).toBeUndefined();
    expect(m.edit).toHaveBeenCalled();
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

  it.each([
    ['unhide', m.unhide],
    ['publishNow', m.publishNow],
  ])('%s refuses a note whose text hits the current denylist', async (action, fn) => {
    m.findById.mockResolvedValueOnce(
      note({
        status: 'hidden',
        items: [{ category: 'new', text: 'Built for ACME corp', importance: 1, sourcePrs: [] }],
      })
    );
    const { error } = await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action } });
    expect(error?.statusCode).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses to make a note live while the stored config is malformed, but still hides', async () => {
    m.getSettings.mockResolvedValue(MALFORMED);
    const live = await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'publishNow' } });
    expect(live.error?.statusCode).toBe(409);
    expect(m.publishNow).not.toHaveBeenCalled();

    m.hide.mockResolvedValueOnce({ kind: 'ok', note: note({ status: 'hidden' }) });
    const hidden = await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'hide' } });
    expect(hidden.error).toBeUndefined();
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

  it('a partial PUT over a malformed stored config is refused rather than wiping the denylist', async () => {
    m.getSettings.mockResolvedValue(MALFORMED);
    const { error } = await call(configHandler, { method: 'PUT', body: { enabled: false } });
    expect(error?.statusCode).toBe(409);
    expect(m.upsert).not.toHaveBeenCalled();

    const full = { enabled: false, modelId: 'gpt-4o-mini', embargoHours: 6, denylist: ['Acme Corp'] };
    const { body } = await call(configHandler, { method: 'PUT', body: full });
    expect(body).toEqual({ config: full, malformed: false });
  });

  it('PUT writes a strict settings.admin_settings.updated entry inside the transaction', async () => {
    const stored = { enabled: true, modelId: 'gpt-4o-mini', embargoHours: 6, denylist: ['Acme Corp'] };
    m.findSetting.mockResolvedValue({ settingValue: stored });

    await call(configHandler, { method: 'PUT', body: { embargoHours: 12 } });

    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: 'releaseNotesConfig' },
      changes: [{ field: 'releaseNotesConfig.embargoHours', before: 6, after: 12 }],
    });
    expect(m.upsert.mock.invocationCallOrder[0]).toBeLessThan(m.audit.mock.invocationCallOrder[0]);
  });

  it('PUT does not report success when the audit write rejects', async () => {
    m.audit.mockRejectedValue(new Error('audit down'));

    const { error } = await call(configHandler, { method: 'PUT', body: { enabled: false } });

    expect(error?.message).toBe('audit down');
    expect(m.invalidate).not.toHaveBeenCalled();
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

describe('release note admin audit', () => {
  it('records an updated entry for an admin edit', async () => {
    m.edit.mockResolvedValue({ kind: 'ok', note: note() });
    await call(editHandler, { method: 'PATCH', query: { id: ID }, body: { headline: 'Faster search' } });

    const auditCalls = m.audit.mock.calls.filter(([, input]) => input.action === 'settings.release_note.updated');
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][1]).toMatchObject({
      action: 'settings.release_note.updated',
      target: { kind: 'settings', id: ID },
      details: { releaseTag: 'v1.2.3', fields: ['headline'] },
    });
  });

  it('does not record the video attach done by a release-notes:write key', async () => {
    m.attachVideo.mockResolvedValue({ kind: 'ok', note: note() });
    const video = { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4', portraitUrl: null };
    await call(editHandler, {
      method: 'PATCH',
      query: { id: ID },
      body: { video },
      keyScopes: ['release-notes:write'],
    });

    expect(m.audit).not.toHaveBeenCalled();
  });

  it('records a status_changed entry carrying the action', async () => {
    m.hide.mockResolvedValue({ kind: 'ok', note: note({ status: 'hidden' }) });
    await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'hide' } });

    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.release_note.status_changed',
      target: { kind: 'settings', id: ID },
      details: { releaseTag: 'v1.2.3', action: 'hide' },
    });
  });

  it('records nothing when the mutation finds no note', async () => {
    m.publishNow.mockResolvedValueOnce({ kind: 'notFound' });
    await call(statusHandler, { method: 'POST', query: { id: ID }, body: { action: 'publishNow' } });

    expect(m.audit).not.toHaveBeenCalled();
  });
});
