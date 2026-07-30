import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // Flipped only after the transaction callback resolves, so a recompute moved INSIDE the
  // transaction is distinguishable from one that runs after the commit.
  committed: { value: false },
  assertCanReplaceDataLakeTags: vi.fn(),
  findByDatalakeTag: vi.fn(),
  deleteFabFile: vi.fn(),
  recomputeLakeStats: vi.fn(),
  updateFabFile: vi.fn(),
  findAccessibleById: vi.fn(),
  findById: vi.fn(),
  logEvent: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as the data-lakes route tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const add =
      (method: string) =>
      (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes[method] = fns[fns.length - 1]), chain);
    const chain: Record<string, unknown> & ((req: { method?: string }, res: unknown) => unknown) = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res),
      { use: () => chain, get: add('GET'), put: add('PUT'), delete: add('DELETE') }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  changeStorageSize: vi.fn(),
  dataLakeRepository: { name: 'dataLakeRepository', findByDatalakeTag: h.findByDatalakeTag },
  fabFileChunkRepository: {},
  fabFileRepository: {
    name: 'fabFileRepository',
    shareable: { findAccessibleById: h.findAccessibleById },
    findById: h.findById,
  },
  fileTagRepository: { incrementFileCountBy: vi.fn() },
  adminSettingsRepository: {},
  sessionRepository: {},
  userRepository: {},
  User: { findById: vi.fn() },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    const result = await fn({});
    h.committed.value = true;
    return result;
  },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertCanReplaceDataLakeTags: h.assertCanReplaceDataLakeTags,
    recomputeLakeStats: h.recomputeLakeStats,
  },
  fabFilesService: { updateFabFile: h.updateFabFile, deleteFabFile: h.deleteFabFile },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }) }));

import handler from '../index';

const FILE_ID = '507f1f77bcf86cd799439011';
const USER = { id: 'u1', isAdmin: false, groups: [] };

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const makeReq = (body: unknown, id: string = FILE_ID) =>
  ({
    method: 'PUT',
    query: { id },
    body,
    user: USER,
    ability: {},
    logger: { updateMetadata: vi.fn(), error: vi.fn() },
  }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);
const gateArgs = () => h.assertCanReplaceDataLakeTags.mock.calls[0][1];

describe('PUT /api/files/[id] - data-lake membership authorization', () => {
  let seenCommittedAtRecompute: boolean[] = [];

  beforeEach(() => {
    seenCommittedAtRecompute = [];
    vi.clearAllMocks();
    h.committed.value = false;
    h.findAccessibleById.mockResolvedValue({
      id: FILE_ID,
      tags: [{ name: 'datalake:lake', strength: 1 }, { name: 'notes' }],
      primaryTag: 'notes',
    });
    h.assertCanReplaceDataLakeTags.mockResolvedValue({ affectedLakes: [], clearPrimaryTag: false });
    h.updateFabFile.mockResolvedValue({ id: FILE_ID, filePath: 'p.txt' });
    h.recomputeLakeStats.mockImplementation(async () => {
      seenCommittedAtRecompute.push(h.committed.value);
      return { fileCount: 1, totalSizeBytes: 10 };
    });
    h.logEvent.mockResolvedValue(undefined);
  });

  it('does not write when the replace gate denies', async () => {
    h.assertCanReplaceDataLakeTags.mockRejectedValue(
      new Error('Only the creator can remove files from this data lake')
    );
    const { res } = makeRes();

    await expect(call(makeReq({ tags: [] }), res)).rejects.toThrow(/remove files/i);
    expect(h.updateFabFile).not.toHaveBeenCalled();
  });

  // An unscoped findById would answer "does this file exist" to a caller who cannot reach it.
  it('reads the stored tags through the shareable accessor, not an unscoped findById', async () => {
    const { res } = makeRes();

    await call(makeReq({ fileName: 'x.txt' }), res);

    expect(h.findAccessibleById).toHaveBeenCalledWith(USER, FILE_ID);
    expect(h.findById).not.toHaveBeenCalled();
  });

  // The client renames by sending only the changed field, so an absent tags key must not read as
  // "remove every tag" - that would 400 every ordinary edit of a lake file.
  it('treats an omitted tags key as no membership change', async () => {
    const { res, json } = makeRes();

    await call(makeReq({ fileName: 'renamed.txt' }), res);

    expect(gateArgs()).toMatchObject({ stored: ['datalake:lake', 'notes'], next: ['datalake:lake', 'notes'] });
    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ id: FILE_ID, filePath: 'p.txt' });
  });

  it('treats an empty tags array as a wholesale replace', async () => {
    const { res } = makeRes();

    await call(makeReq({ tags: [] }), res);

    expect(gateArgs()).toMatchObject({ next: [] });
  });

  // A non-array is unreadable, so it must demand manage rights rather than skip the check.
  it('treats a non-array tags value as removing everything', async () => {
    const { res } = makeRes();

    await call(makeReq({ tags: 'datalake:lake' }), res);

    expect(gateArgs()).toMatchObject({ next: [] });
  });

  it('forwards the submitted and stored primaryTag to the gate', async () => {
    const { res } = makeRes();

    await call(makeReq({ tags: [{ name: 'notes' }], primaryTag: 'datalake:other' }), res);

    expect(gateArgs()).toMatchObject({ primaryTag: 'datalake:other', storedPrimaryTag: 'notes' });
  });

  // Otherwise the file keeps a primary label naming a tag it no longer carries.
  it('clears primaryTag when the gate says the write drops the tag it names', async () => {
    h.assertCanReplaceDataLakeTags.mockResolvedValue({ affectedLakes: [], clearPrimaryTag: true });
    const { res } = makeRes();

    await call(makeReq({ tags: [], primaryTag: 'datalake:lake' }), res);

    expect(h.updateFabFile.mock.calls[0][1]).toMatchObject({ primaryTag: null });
  });

  it('recomputes stats for EVERY affected lake, after the update commits', async () => {
    h.assertCanReplaceDataLakeTags.mockResolvedValue({
      affectedLakes: [
        { id: 'lakeA', datalakeTag: 'datalake:a' },
        { id: 'lakeB', datalakeTag: 'datalake:b' },
      ],
      clearPrimaryTag: false,
    });
    const { res } = makeRes();

    await call(makeReq({ tags: [{ name: 'datalake:b', strength: 1 }] }), res);

    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(2);
    expect(h.recomputeLakeStats).toHaveBeenCalledWith('lakeA', 'datalake:a', expect.anything());
    expect(h.recomputeLakeStats).toHaveBeenCalledWith('lakeB', 'datalake:b', expect.anything());
    expect(h.updateFabFile.mock.invocationCallOrder[0]).toBeLessThan(h.recomputeLakeStats.mock.invocationCallOrder[0]);
    // Not merely "after updateFabFile" - after the transaction COMMITTED, so a stats failure
    // cannot roll the write back and the retried callback cannot recompute repeatedly.
    expect(seenCommittedAtRecompute).toEqual([true, true]);
  });

  it('does not recompute when no lake membership changed', async () => {
    const { res } = makeRes();

    await call(makeReq({ tags: [{ name: 'notes' }] }), res);

    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
  });

  // Stats are a cache with other rebuild paths, so a failure must not 500 a committed write.
  it('still returns the updated file when a stats recompute throws', async () => {
    h.assertCanReplaceDataLakeTags.mockResolvedValue({
      affectedLakes: [
        { id: 'lakeA', datalakeTag: 'datalake:a' },
        { id: 'lakeB', datalakeTag: 'datalake:b' },
      ],
      clearPrimaryTag: false,
    });
    h.recomputeLakeStats.mockRejectedValueOnce(new Error('mongo down'));
    const req = makeReq({ tags: [] });
    const { res, json } = makeRes();

    await call(req, res);

    expect(json).toHaveBeenCalledWith({ id: FILE_ID, filePath: 'p.txt' });
    expect((req as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalled();
    // The other lake must still be recomputed - one bad lake cannot skip the rest.
    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(2);
  });

  // logEvent is awaited unguarded, so ordering it after the recompute is what keeps a failed
  // analytics write from silently costing the lake its stats.
  it('recomputes stats even when analytics logging fails', async () => {
    h.assertCanReplaceDataLakeTags.mockResolvedValue({
      affectedLakes: [{ id: 'lakeA', datalakeTag: 'datalake:a' }],
      clearPrimaryTag: false,
    });
    h.logEvent.mockRejectedValue(new Error('analytics down'));
    const { res } = makeRes();

    await expect(call(makeReq({ tags: [] }), res)).rejects.toThrow(/analytics down/);
    expect(h.recomputeLakeStats).toHaveBeenCalledWith('lakeA', 'datalake:a', expect.anything());
  });

  // 'abcdefghijkl' is 12 bytes, so ObjectId.isValid ACCEPTS it; only the round-trip clause
  // rejects it. Without that clause the unvalidated id reaches the stored-tag read as a CastError.
  it.each(['not-an-object-id', 'abcdefghijkl'])('404s the malformed id %o before touching anything', async id => {
    const { res, status } = makeRes();

    await call(makeReq({ tags: [] }, id), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(h.findAccessibleById).not.toHaveBeenCalled();
    expect(h.assertCanReplaceDataLakeTags).not.toHaveBeenCalled();
    expect(h.updateFabFile).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/files/[id] - a delete is a lake membership change too', () => {
  const makeDelReq = () =>
    ({
      method: 'DELETE',
      query: { id: FILE_ID },
      body: {},
      user: USER,
      ability: {},
      logger: { updateMetadata: vi.fn(), error: vi.fn() },
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    h.committed.value = false;
    h.findById.mockResolvedValue({ id: FILE_ID, userId: USER.id, tags: [{ name: 'datalake:a' }, { name: 'notes' }] });
    h.deleteFabFile.mockResolvedValue({ action: 'deleted', fabFile: { id: FILE_ID, userId: USER.id } });
    h.findByDatalakeTag.mockResolvedValue({ id: 'lakeA', datalakeTag: 'datalake:a' });
    h.recomputeLakeStats.mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 });
    h.logEvent.mockResolvedValue(undefined);
  });

  // deleteFabFile soft-deletes and computeDataLakeStats matches deletedAt: null, so without this
  // every lake the file belonged to keeps counting it.
  it('recomputes stats for each lake the deleted file belonged to', async () => {
    const { res } = makeRes();

    await call(makeDelReq(), res);

    expect(h.findByDatalakeTag).toHaveBeenCalledWith('datalake:a');
    expect(h.recomputeLakeStats).toHaveBeenCalledWith('lakeA', 'datalake:a', expect.anything());
  });

  it('does not recompute for a file that was in no lake', async () => {
    h.findById.mockResolvedValue({ id: FILE_ID, userId: USER.id, tags: [{ name: 'notes' }] });
    const { res } = makeRes();

    await call(makeDelReq(), res);

    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
  });

  // An unshare leaves the file - and its membership - in place.
  it('does not recompute when the delete was an unshare rather than a removal', async () => {
    h.deleteFabFile.mockResolvedValue({ action: 'unshared', fabFile: { id: FILE_ID, userId: 'someone-else' } });
    const { res } = makeRes();

    await call(makeDelReq(), res);

    expect(h.recomputeLakeStats).not.toHaveBeenCalled();
  });

  it('still returns the delete result when a stats recompute throws', async () => {
    h.recomputeLakeStats.mockRejectedValue(new Error('mongo down'));
    const req = makeDelReq();
    const { res, json } = makeRes();

    await call(req, res);

    expect(json).toHaveBeenCalledWith({ msg: 'Fab file deleted', action: 'deleted' });
    expect((req as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalled();
  });
});
