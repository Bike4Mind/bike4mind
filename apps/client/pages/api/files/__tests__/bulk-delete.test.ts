import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // deleteFabFile runs for real over these, so 'deleted' vs 'unshared' comes from the service.
  findByIdAndUserId: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  deleteManyByFabFileId: vi.fn(),
  findAllWithKnowledgeId: vi.fn(),
  sessionUpdate: vi.fn(),
  userFindById: vi.fn(),
  touchLastActivityBy: vi.fn(),
  findByDatalakeTag: vi.fn(),
  computeDataLakeStats: vi.fn(),
  setStats: vi.fn(),
  storageDelete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'DELETE']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((routes.POST = fn), chain),
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

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  changeStorageSize: vi.fn(),
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, setStats: h.setStats },
  fabFileChunkRepository: { deleteManyByFabFileId: h.deleteManyByFabFileId },
  fabFileRepository: {
    findByIdAndUserId: h.findByIdAndUserId,
    findById: h.findById,
    update: h.update,
    computeDataLakeStats: h.computeDataLakeStats,
  },
  fileTagRepository: { touchLastActivityBy: h.touchLastActivityBy },
  sessionRepository: { findAllWithKnowledgeId: h.findAllWithKnowledgeId, update: h.sessionUpdate },
  userRepository: { findById: h.userFindById },
  withTransaction: (fn: (session?: unknown) => Promise<unknown>) => fn(undefined),
  User: { findById: () => ({ session: async () => null }) },
}));

import handler from '../bulk-delete';

const OWNER = 'u1';
const LAKE = {
  id: 'lake-1',
  createdByUserId: OWNER,
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const logger = { updateMetadata: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (fileIds: string[], res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'DELETE', user: { id: OWNER, isAdmin: false }, ability: {}, body: { fileIds }, logger },
    res
  );

const memberFile = (id: string, userId = OWNER) => ({
  id,
  userId,
  fileName: `${id}.txt`,
  tags: [{ name: LAKE.datalakeTag, strength: 1 }],
  users: [] as { userId: string }[],
});

describe('bulk-delete - data-lake stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: OWNER });
    h.update.mockResolvedValue(undefined);
    h.deleteManyByFabFileId.mockResolvedValue(undefined);
    h.findAllWithKnowledgeId.mockResolvedValue([]);
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 1, totalSizeBytes: 100 });
    h.setStats.mockResolvedValue(undefined);
  });

  it('recomputes each affected lake exactly once for a batch out of the same lake', async () => {
    const files = new Map([
      ['507f1f77bcf86cd799439011', memberFile('507f1f77bcf86cd799439011')],
      ['507f1f77bcf86cd799439012', memberFile('507f1f77bcf86cd799439012')],
      ['507f1f77bcf86cd799439013', memberFile('507f1f77bcf86cd799439013')],
    ]);
    h.findById.mockImplementation(async (id: string) => files.get(id) ?? null);
    h.findByIdAndUserId.mockImplementation(async (id: string) => files.get(id) ?? null);
    const { res } = makeRes();

    await run([...files.keys()], res);

    expect(h.computeDataLakeStats).toHaveBeenCalledWith({
      datalakeTag: LAKE.datalakeTag,
      fileTagPrefix: LAKE.fileTagPrefix,
      creatorUserId: LAKE.createdByUserId,
    });
    // Three member files, one lake: the meta-tags are deduped, so one aggregation, not three.
    expect(h.computeDataLakeStats).toHaveBeenCalledTimes(1);
    expect(h.setStats).toHaveBeenCalledTimes(1);
  });

  it('does not recompute for a batch that only unshares', async () => {
    const shared = { ...memberFile('507f1f77bcf86cd799439011', 'someone-else'), users: [{ userId: OWNER }] };
    h.findById.mockResolvedValue(shared);
    h.findByIdAndUserId.mockResolvedValue(null);
    const { res, json } = makeRes();

    await run(['507f1f77bcf86cd799439011'], res);

    expect(json.mock.calls[0][0].results.unshared).toHaveLength(1);
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    expect(h.setStats).not.toHaveBeenCalled();
  });

  it('recomputes only for the files that actually deleted, ignoring unshared ones', async () => {
    const owned = memberFile('507f1f77bcf86cd799439011');
    const shared = {
      ...memberFile('507f1f77bcf86cd799439012', 'someone-else'),
      tags: [{ name: 'datalake:orga:other-lake', strength: 1 }],
      users: [{ userId: OWNER }],
    };
    h.findById.mockImplementation(async (id: string) => (id === owned.id ? owned : shared));
    h.findByIdAndUserId.mockImplementation(async (id: string) => (id === owned.id ? owned : null));
    const { res } = makeRes();

    await run([owned.id, shared.id], res);

    // The unshared file's lake must not be dragged into the recompute: its membership never moved.
    expect(h.findByDatalakeTag).toHaveBeenCalledTimes(1);
    expect(h.findByDatalakeTag).toHaveBeenCalledWith(LAKE.datalakeTag);
  });
});

describe('bulk-delete - not-found reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: OWNER });
    h.findAllWithKnowledgeId.mockResolvedValue([]);
  });

  it('reports a genuinely missing file under notFound, not silently', async () => {
    h.findById.mockResolvedValue(null);
    h.findByIdAndUserId.mockResolvedValue(null);
    const { res, json } = makeRes();

    await run(['507f1f77bcf86cd799439011'], res);

    const body = json.mock.calls[0][0];
    expect(body.results.notFound).toEqual(['507f1f77bcf86cd799439011']);
    expect(body.message).toBe('1 file(s) not found');
  });

  it('reports a file the actor has no access to under the same notFound bucket, not a distinct "denied" one', async () => {
    // Exists, but the actor is neither owner nor in the share list. The response must not let a
    // caller distinguish this from genuine absence - that would let bulk-delete be used to probe
    // for other users' file ids (see fabFileService/get.ts et al for the same no-enumeration rule).
    const inaccessible = { ...memberFile('507f1f77bcf86cd799439011', 'someone-else'), users: [] };
    h.findById.mockResolvedValue(inaccessible);
    h.findByIdAndUserId.mockResolvedValue(null);
    const { res, json } = makeRes();

    await run(['507f1f77bcf86cd799439011'], res);

    const body = json.mock.calls[0][0];
    expect(body.results.notFound).toEqual(['507f1f77bcf86cd799439011']);
    expect(body.results).not.toHaveProperty('denied');
    expect(body.message).toBe('1 file(s) not found');
  });
});

// Deleting files changes which files carry a tag, so each one is marked as recently used. The
// ownership check is the route's own decision - deleting a file shared WITH you is an unshare, which
// changes nothing about your tags - and the same decision is made independently in files/[id].
describe('bulk-delete - tag activity', () => {
  const taggedFile = (id: string, userId = OWNER) => ({
    ...memberFile(id, userId),
    tags: [
      { name: 'invoices', strength: 0 },
      { name: 'q3', strength: 0 },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: OWNER });
    h.update.mockResolvedValue(undefined);
    h.deleteManyByFabFileId.mockResolvedValue(undefined);
    h.findAllWithKnowledgeId.mockResolvedValue([]);
  });

  it('touches every tag on an owned file', async () => {
    const owned = taggedFile('507f1f77bcf86cd799439011');
    h.findById.mockResolvedValue(owned);
    h.findByIdAndUserId.mockResolvedValue(owned);
    const { res } = makeRes();

    await run([owned.id], res);

    expect(h.touchLastActivityBy).toHaveBeenCalledWith({ name: 'invoices', userId: OWNER });
    expect(h.touchLastActivityBy).toHaveBeenCalledWith({ name: 'q3', userId: OWNER });
    expect(h.touchLastActivityBy).toHaveBeenCalledTimes(2);
  });

  it('skips a malformed tag entry rather than touching a nameless tag', async () => {
    const owned = {
      ...taggedFile('507f1f77bcf86cd799439011'),
      tags: [
        { name: 'invoices', strength: 0 },
        { name: null as unknown as string, strength: 0 },
      ],
    };
    h.findById.mockResolvedValue(owned);
    h.findByIdAndUserId.mockResolvedValue(owned);
    const { res } = makeRes();

    await run([owned.id], res);

    expect(h.touchLastActivityBy).toHaveBeenCalledTimes(1);
    expect(h.touchLastActivityBy).toHaveBeenCalledWith({ name: 'invoices', userId: OWNER });
  });

  it('touches nothing when the file belongs to someone else', async () => {
    const shared = { ...taggedFile('507f1f77bcf86cd799439011', 'someone-else'), users: [{ userId: OWNER }] };
    h.findById.mockResolvedValue(shared);
    h.findByIdAndUserId.mockResolvedValue(null);
    const { res } = makeRes();

    await run([shared.id], res);

    // The names are the owner's tags, not the actor's: touching them would bump a same-named tag in
    // the actor's own registry that they never changed.
    expect(h.touchLastActivityBy).not.toHaveBeenCalled();
  });
});
