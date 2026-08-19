import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertCanWriteDataLakeTags: vi.fn(),
  toggleTags: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as the data-lake route tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertCanWriteDataLakeTags: h.assertCanWriteDataLakeTags },
  fabFilesService: { toggleTags: h.toggleTags },
}));
vi.mock('@bike4mind/database', () => ({
  // The config-audit repos the code under test now wires (see lakeConfigAuditDb). Stubbed
  // rather than omitted because this mock REPLACES the whole module: a missing export is an
  // import-time failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeRepository: { name: 'dataLakes' },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  fabFileRepository: { name: 'fabFiles' },
  fileTagRepository: { name: 'fileTags' },
  userRepository: { name: 'users' },
}));

import handler from '../toggle';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (body: unknown, user: Record<string, unknown> = { id: 'u1', isAdmin: false }) =>
  ({ method: 'POST', body, user }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('POST /api/files/tags/toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertCanWriteDataLakeTags.mockResolvedValue(undefined);
    h.toggleTags.mockResolvedValue([{ id: 'f1' }]);
  });

  it('gives the service the data-lake repository so lake toggles reach the membership path', async () => {
    const { res, json } = makeRes();

    await call(req({ ids: ['f1'], tags: ['datalake:lake'] }), res);

    // Without this adapter the service cannot resolve a meta-tag to its lake, and the toggle
    // falls back to writing the tag as if it were an ordinary one.
    expect(h.toggleTags).toHaveBeenCalledWith(
      'u1',
      { ids: ['f1'], tags: ['datalake:lake'] },
      expect.objectContaining({
        // Named explicitly rather than expect.anything(): a toggle can flip a draft lake active,
        // so dropping either audit adapter here would leave that transition unrecorded and still
        // compile - `adminSettings` is optional, and the event repo degrades to writing nothing.
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.anything(),
          adminSettings: expect.anything(),
        }),
      })
    );
    expect(h.toggleTags.mock.calls[0][2].db.dataLakes).toEqual({ name: 'dataLakes' });
    expect(json).toHaveBeenCalledWith([{ id: 'f1' }]);
  });

  it('rejects an unauthenticated caller before any write', async () => {
    const { res } = makeRes();

    await expect(call(req({ ids: ['f1'], tags: ['x'] }, { id: undefined }), res)).rejects.toThrow(/unauthorized/i);
    expect(h.toggleTags).not.toHaveBeenCalled();
  });

  it('does not toggle anything when the lake write gate denies a meta-tag', async () => {
    h.assertCanWriteDataLakeTags.mockRejectedValue(new Error("Only the creator can change this data lake's files"));
    const { res } = makeRes();

    await expect(call(req({ ids: ['f1'], tags: ['datalake:someone-elses'] }), res)).rejects.toThrow(
      /only the creator/i
    );
    expect(h.toggleTags).not.toHaveBeenCalled();
  });

  it('takes the actor from the session, never from the request body', async () => {
    const { res } = makeRes();

    await call(req({ ids: ['f1'], tags: ['datalake:lake'], userId: 'attacker', isAdmin: true }), res);

    expect(h.assertCanWriteDataLakeTags).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      ['datalake:lake'],
      expect.anything()
    );
    expect(h.toggleTags.mock.calls[0][0]).toBe('u1');
  });

  it('survives a malformed tags payload rather than throwing on the gate', async () => {
    const { res } = makeRes();

    await call(req({ ids: ['f1'], tags: 'not-an-array' }), res);

    expect(h.assertCanWriteDataLakeTags).toHaveBeenCalledWith({ userId: 'u1', isAdmin: false }, [], expect.anything());
  });
});
