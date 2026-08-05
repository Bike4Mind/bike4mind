import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // deleteFabFile runs for real over these, so the 'deleted' vs 'unshared' outcome is produced by
  // the service rather than stubbed - the gate under test keys off exactly that value.
  findByIdAndUserId: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  deleteManyByFabFileId: vi.fn(),
  findAllWithKnowledgeId: vi.fn(),
  sessionUpdate: vi.fn(),
  userFindById: vi.fn(),
  incrementFileCountBy: vi.fn(),
  findByDatalakeTag: vi.fn(),
  computeDataLakeStats: vi.fn(),
  setStats: vi.fn(),
  activateIfDraft: vi.fn(),
  find: vi.fn(),
  storageDelete: vi.fn(),
}));

// Same callable chain as index.put.test.ts: the module registers get/put/delete in sequence and
// the default export routes by req.method, so one import can drive just the DELETE handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'DELETE']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ delete: h.storageDelete, upload: vi.fn(), getSignedUrl: vi.fn() }),
}));

// Spread the real module first for the same reason index.put.test.ts does: a transitively-loaded
// model still needs mongoose/BaseRepository at import time, and a full-replace mock omits those.
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  changeStorageSize: vi.fn(),
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, setStats: h.setStats, find: h.find },
  fabFileChunkRepository: { deleteManyByFabFileId: h.deleteManyByFabFileId },
  fabFileRepository: {
    findByIdAndUserId: h.findByIdAndUserId,
    findById: h.findById,
    update: h.update,
    computeDataLakeStats: h.computeDataLakeStats,
  },
  fileTagRepository: { incrementFileCountBy: h.incrementFileCountBy },
  adminSettingsRepository: {},
  sessionRepository: { findAllWithKnowledgeId: h.findAllWithKnowledgeId, update: h.sessionUpdate },
  userRepository: { findById: h.userFindById },
  withTransaction: (fn: (session?: unknown) => Promise<unknown>) => fn(undefined),
  User: { findById: () => ({ session: async () => null }) },
}));

import handler from '../index';

// The route 404s a non-round-tripping id before it reaches anything, so the fixture has to be a
// real 24-hex ObjectId string rather than a readable slug.
const FILE_ID = '507f1f77bcf86cd799439011';
const OWNER = 'u1';

const LAKE = {
  id: 'lake-1',
  createdByUserId: OWNER,
  datalakeTag: 'datalake:orga:acme-2026',
  // Deliberately unlike the tag: a recompute handed a narrowed shape would lose this and the
  // creator anchor, and quietly count the meta-tag arm alone.
  fileTagPrefix: 'acme:',
};
const OTHER_LAKE = {
  id: 'lake-2',
  createdByUserId: OWNER,
  datalakeTag: 'datalake:orga:globex-2026',
  fileTagPrefix: 'globex:',
};

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};

const logger = { updateMetadata: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

const req = (id: string = FILE_ID) =>
  ({
    method: 'DELETE',
    user: { id: OWNER, isAdmin: false },
    ability: {},
    query: { id },
    logger,
  }) as never;

const run = (res: unknown, id?: string) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(id), res);

const fabFile = (overrides: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  userId: OWNER,
  fileName: 'notes.txt',
  tags: [],
  users: [],
  ...overrides,
});

/** Route the file through the OWNED arm of deleteFabFile, which returns action: 'deleted'. */
const givenOwnedFile = (tags: { name: string; strength: number }[]) => {
  const doc = fabFile({ tags });
  h.findById.mockResolvedValue(doc);
  h.findByIdAndUserId.mockResolvedValue(doc);
  return doc;
};

/** Route it through the SHARED arm instead, which returns action: 'unshared'. */
const givenSharedFile = (tags: { name: string; strength: number }[]) => {
  const doc = fabFile({ userId: 'someone-else', tags, users: [{ userId: OWNER }] });
  h.findById.mockResolvedValue(doc);
  h.findByIdAndUserId.mockResolvedValue(null);
  return doc;
};

describe('DELETE /api/files/[id] - data-lake stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: OWNER });
    h.update.mockResolvedValue(undefined);
    h.deleteManyByFabFileId.mockResolvedValue(undefined);
    h.findAllWithKnowledgeId.mockResolvedValue([]);
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 3, totalSizeBytes: 300 });
    h.setStats.mockResolvedValue(undefined);
  });

  it('recomputes the lake stats when a file carrying a meta-tag is deleted', async () => {
    givenOwnedFile([{ name: LAKE.datalakeTag, strength: 1 }]);
    const { res, json } = makeRes();

    await run(res);

    expect(json.mock.calls[0][0]).toMatchObject({ action: 'deleted' });
    // The recompute must see the lake's WHOLE membership scope. Asserting the persisted count
    // alone would pass just as well against a meta-tag-only scope writing a different number.
    expect(h.computeDataLakeStats).toHaveBeenCalledWith({
      datalakeTag: LAKE.datalakeTag,
      fileTagPrefix: LAKE.fileTagPrefix,
      creatorUserId: LAKE.createdByUserId,
    });
    expect(h.setStats).toHaveBeenCalledWith(LAKE.id, { fileCount: 3, totalSizeBytes: 300 });
  });

  it('does not recompute when the outcome is unshared', async () => {
    // An unshare edits only the file's `users` array - `tags`, `userId` and `deletedAt` are all
    // untouched, so neither membership arm moves and the stored counts are still correct.
    givenSharedFile([{ name: LAKE.datalakeTag, strength: 1 }]);
    const { res, json } = makeRes();

    await run(res);

    expect(json.mock.calls[0][0]).toMatchObject({ action: 'unshared' });
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    expect(h.setStats).not.toHaveBeenCalled();
  });

  it('recomputes the remaining lakes when one lake fails', async () => {
    givenOwnedFile([
      { name: LAKE.datalakeTag, strength: 1 },
      { name: OTHER_LAKE.datalakeTag, strength: 1 },
    ]);
    h.findByDatalakeTag.mockImplementation(async (tag: string) => (tag === LAKE.datalakeTag ? LAKE : OTHER_LAKE));
    h.setStats.mockImplementation(async (lakeId: string) => {
      if (lakeId === LAKE.id) throw new Error('stats write failed');
    });
    const { res, json } = makeRes();

    await run(res);

    expect(h.setStats).toHaveBeenCalledWith(OTHER_LAKE.id, expect.anything());
    expect(logger.error).toHaveBeenCalled();
    // A stats failure must not turn a successful delete into an error response.
    expect(json.mock.calls[0][0]).toMatchObject({ action: 'deleted' });
  });

  it('skips a meta-tag whose lake no longer exists without failing the delete', async () => {
    givenOwnedFile([{ name: LAKE.datalakeTag, strength: 1 }]);
    h.findByDatalakeTag.mockResolvedValue(null);
    const { res, json } = makeRes();

    await run(res);

    expect(h.setStats).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0]).toMatchObject({ action: 'deleted' });
  });

  it('looks up no lake for a file carrying no meta-tag, including a malformed tag entry', async () => {
    givenOwnedFile([
      { name: 'notes', strength: 1 },
      { name: null as unknown as string, strength: 1 },
    ]);
    const { res, json } = makeRes();

    await run(res);

    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0]).toMatchObject({ action: 'deleted' });
  });
});
