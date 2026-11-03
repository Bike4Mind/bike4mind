import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // deleteFabFile runs for real over these, so 'deleted' vs 'unshared' comes from the service.
  findByIdAndUserId: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  updateUserShares: vi.fn(),
  deleteManyByFabFileId: vi.fn(),
  findAllWithKnowledgeId: vi.fn(),
  sessionUpdate: vi.fn(),
  userFindById: vi.fn(),
  touchLastActivityBy: vi.fn(),
  findByDatalakeTag: vi.fn(),
  computeDataLakeStats: vi.fn(),
  setStats: vi.fn(),
  activateIfDraft: vi.fn(),
  storageDelete: vi.fn(),
  recordConfigChange: vi.fn(),
  incrementCurrentStorage: vi.fn(),
  changeStorageSize: vi.fn(),
  userForRefund: vi.fn(),
  pullSystemFilesForUsers: vi.fn(),
  pullFileReferences: vi.fn(),
  logEvent: vi.fn(),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
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

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ delete: h.storageDelete, upload: vi.fn(), getSignedUrl: vi.fn() }),
  getGeneratedImageStorage: () => ({ delete: vi.fn() }),
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  changeStorageSize: h.changeStorageSize,
  organizationRepository: { incrementCurrentStorage: h.incrementCurrentStorage },
  dataLakeRepository: {
    findByDatalakeTag: h.findByDatalakeTag,
    setStats: h.setStats,
    activateIfDraft: h.activateIfDraft,
  },
  lakeConfigChangeEventRepository: { record: h.recordConfigChange },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  fabFileChunkRepository: { deleteManyByFabFileId: h.deleteManyByFabFileId },
  fabFileRepository: {
    findByIdAndUserId: h.findByIdAndUserId,
    findById: h.findById,
    update: h.update,
    computeDataLakeStats: h.computeDataLakeStats,
    shareable: { updateUserShares: h.updateUserShares },
  },
  fileTagRepository: { touchLastActivityBy: h.touchLastActivityBy },
  sessionRepository: { findAllWithKnowledgeId: h.findAllWithKnowledgeId, update: h.sessionUpdate },
  userRepository: {
    findById: h.userFindById,
    pullSystemFilesForUsers: h.pullSystemFilesForUsers,
  },
  projectRepository: { pullFileReferences: h.pullFileReferences },
  withTransaction: (fn: (session?: unknown) => Promise<unknown>) => fn(undefined),
  User: { findById: (id: string) => ({ session: async () => h.userForRefund(id) }) },
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

const run = (fileIds: string[], res: unknown, over: Record<string, unknown> = {}) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'DELETE', user: { id: OWNER, isAdmin: false }, ability: {}, body: { fileIds }, logger, ...over },
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
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 1, totalSizeBytes: 100, totalChunkedChars: 0 });
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
      kind: 'owned',
      datalakeTag: LAKE.datalakeTag,
      fileTagPrefix: LAKE.fileTagPrefix,
      creatorUserId: LAKE.createdByUserId,
    });
    // Three member files, one lake: the meta-tags are deduped, so one aggregation, not three.
    expect(h.computeDataLakeStats).toHaveBeenCalledTimes(1);
    expect(h.setStats).toHaveBeenCalledTimes(1);
  });

  it('unlinks each deleted file against its own owner and recipients, never a batch-wide union', async () => {
    const files = new Map([
      ['507f1f77bcf86cd799439011', { ...memberFile('507f1f77bcf86cd799439011'), users: [{ userId: 'recipient-1' }] }],
      ['507f1f77bcf86cd799439012', { ...memberFile('507f1f77bcf86cd799439012'), users: [{ userId: 'recipient-2' }] }],
    ]);
    h.findById.mockImplementation(async (id: string) => files.get(id) ?? null);
    h.findByIdAndUserId.mockImplementation(async (id: string) => files.get(id) ?? null);
    const { res } = makeRes();

    await run([...files.keys()], res);

    const [first, second] = [...files.keys()];
    expect(h.pullSystemFilesForUsers).toHaveBeenCalledWith([OWNER, 'recipient-1'], [first]);
    expect(h.pullSystemFilesForUsers).toHaveBeenCalledWith([OWNER, 'recipient-2'], [second]);
    expect(h.pullFileReferences).toHaveBeenCalledWith([first], { userIds: [OWNER, 'recipient-1'] });
    expect(h.pullFileReferences).toHaveBeenCalledWith([second], { userIds: [OWNER, 'recipient-2'] });
  });

  it('never pulls a merely unshared file from a holder who still has it, even when the same batch deletes another file', async () => {
    const owned = { ...memberFile('507f1f77bcf86cd799439021'), users: [{ userId: 'recipient-1' }] };
    // Owned by Carol, shared directly with the caller: the caller's delete is an unshare.
    const shared = { ...memberFile('507f1f77bcf86cd799439022', 'carol'), users: [{ userId: OWNER }] };
    h.findById.mockImplementation(async (id: string) => (id === owned.id ? owned : shared));
    h.findByIdAndUserId.mockImplementation(async (id: string) => (id === owned.id ? owned : null));
    const { res } = makeRes();

    await run([owned.id, shared.id], res);

    // The unshared file keeps its place in Carol's project; only the caller's own system files let go.
    expect(h.pullFileReferences).toHaveBeenCalledWith([owned.id], { userIds: [OWNER, 'recipient-1'] });
    for (const [fileIds] of h.pullFileReferences.mock.calls) {
      expect(fileIds).not.toContain(shared.id);
    }
    expect(h.pullSystemFilesForUsers).toHaveBeenCalledWith([OWNER], [shared.id]);
  });

  it('never unlinks the references of a file whose delete rolled back - that file is still live', async () => {
    const rolledBack = '507f1f77bcf86cd799439011';
    const committed = '507f1f77bcf86cd799439012';
    const files = new Map([
      [rolledBack, { ...memberFile(rolledBack), users: [{ userId: 'recipient-1' }] }],
      [committed, memberFile(committed)],
    ]);
    h.findById.mockImplementation(async (id: string) => files.get(id) ?? null);
    h.findByIdAndUserId.mockImplementation(async (id: string) => files.get(id) ?? null);
    h.logEvent.mockRejectedValueOnce(new Error('log failed'));
    const { res } = makeRes();

    await run([...files.keys()], res);

    expect(h.pullSystemFilesForUsers).toHaveBeenCalledTimes(1);
    expect(h.pullSystemFilesForUsers).toHaveBeenCalledWith([OWNER], [committed]);
    expect(h.pullFileReferences).toHaveBeenCalledWith([committed], { userIds: [OWNER] });
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
    // Asserted by which tag is looked up, not by a call count: an owned delete now resolves its
    // own member lakes a second time to record the membership `removed` event.
    expect(h.findByDatalakeTag).toHaveBeenCalledWith(LAKE.datalakeTag);
    expect(h.findByDatalakeTag).not.toHaveBeenCalledWith('datalake:orga:other-lake');
    expect(h.setStats).toHaveBeenCalledTimes(1);
  });
});

/**
 * A bulk delete can leave enough files behind to flip a draft lake active, which writes an
 * append-only config-change row an owner reads. The actor is built HERE, so this is the only place
 * the attribution can be pinned - drop the route's `auditPrincipal` line and every other suite
 * stays green while key-driven deletes are recorded as the owning human's own edit.
 */
// A bulk delete that leaves a lake with members no longer publishes a draft lake as a
// side effect - only the explicit promoteDataLake door does.
describe('bulk-delete - draft lakes stay draft', () => {
  const FILE_ID = '507f1f77bcf86cd799439011';

  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: OWNER });
    h.update.mockResolvedValue(undefined);
    h.deleteManyByFabFileId.mockResolvedValue(undefined);
    h.findAllWithKnowledgeId.mockResolvedValue([]);
    h.findByDatalakeTag.mockResolvedValue({ ...LAKE, status: 'draft' });
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 2, totalSizeBytes: 200, totalChunkedChars: 0 });
    h.setStats.mockResolvedValue(undefined);
    h.recordConfigChange.mockResolvedValue({});
    const file = memberFile(FILE_ID);
    h.findById.mockResolvedValue(file);
    h.findByIdAndUserId.mockResolvedValue(file);
  });

  it("corrects a draft lake's stats on bulk delete without publishing it", async () => {
    const { res } = makeRes();
    await run([FILE_ID], res);

    expect(h.setStats).toHaveBeenCalledWith(LAKE.id, expect.anything());
    expect(h.activateIfDraft).not.toHaveBeenCalled();
    expect(h.recordConfigChange).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auto-activate' }));
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

  it('composes the message correctly when a batch deletes, not-founds, and fails all at once', async () => {
    const DELETED_ID = '507f1f77bcf86cd799439021';
    const MISSING_ID = '507f1f77bcf86cd799439022';
    const FAILING_ID = '507f1f77bcf86cd799439023';

    const deletedFile = { id: DELETED_ID, userId: OWNER, fileName: 'a.txt', tags: [], users: [] };
    const failingFile = {
      id: FAILING_ID,
      userId: OWNER,
      fileName: 'b.txt',
      tags: [],
      users: [],
      filePath: 'uploads/b.txt',
    };

    h.findByIdAndUserId.mockImplementation(async (id: string) =>
      id === DELETED_ID ? deletedFile : id === FAILING_ID ? failingFile : null
    );
    h.findById.mockImplementation(async (id: string) =>
      id === DELETED_ID ? deletedFile : id === FAILING_ID ? failingFile : null
    );
    h.storageDelete.mockImplementation(async (path: string) => {
      if (path === 'uploads/b.txt') throw new Error('S3 unavailable');
    });

    const { res, json } = makeRes();

    await run([DELETED_ID, MISSING_ID, FAILING_ID], res);

    const body = json.mock.calls[0][0];
    expect(body.results.deleted).toEqual([DELETED_ID]);
    expect(body.results.notFound).toEqual([MISSING_ID]);
    expect(body.results.failed).toEqual([{ id: FAILING_ID, error: 'S3 unavailable' }]);
    expect(body.message).toBe('Deleted 1 file(s), 1 file(s) not found, Failed to process 1 file(s)');
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

// Storage is billed to the file's OWNER (its org, else its uploader), not to whoever runs the delete.
describe('bulk-delete - storage refunds per owner', () => {
  const chargedFile = (id: string, over: Record<string, unknown>) => ({
    id,
    userId: OWNER,
    fileName: `${id}.txt`,
    filePath: `uploads/${id}.txt`,
    tags: [],
    users: [],
    storageChargedAt: new Date('2026-10-10T00:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: OWNER });
    h.update.mockResolvedValue(undefined);
    h.deleteManyByFabFileId.mockResolvedValue(undefined);
    h.findAllWithKnowledgeId.mockResolvedValue([]);
    h.storageDelete.mockResolvedValue(undefined);
    h.incrementCurrentStorage.mockResolvedValue(undefined);
    h.changeStorageSize.mockResolvedValue(undefined);
    h.userForRefund.mockImplementation(async (id: string) => ({ id, save: vi.fn() }));
  });

  it('refunds each owner its own sum: personal files to the uploader, org files to the org', async () => {
    const files = new Map(
      [
        chargedFile('507f1f77bcf86cd799439031', { fileSize: 100 }),
        chargedFile('507f1f77bcf86cd799439032', { fileSize: 40, organizationId: 'org1' }),
        chargedFile('507f1f77bcf86cd799439033', { fileSize: 60, organizationId: 'org1' }),
        chargedFile('507f1f77bcf86cd799439034', { fileSize: 7, organizationId: 'org2' }),
        chargedFile('507f1f77bcf86cd799439035', { fileSize: 5 }),
      ].map(file => [file.id, file])
    );
    h.findById.mockImplementation(async (id: string) => files.get(id) ?? null);
    h.findByIdAndUserId.mockImplementation(async (id: string) => files.get(id) ?? null);
    const { res, json } = makeRes();

    await run([...files.keys()], res);

    expect(json.mock.calls[0][0].results.deleted).toHaveLength(5);
    expect(h.incrementCurrentStorage).toHaveBeenCalledTimes(2);
    expect(h.incrementCurrentStorage).toHaveBeenCalledWith('org1', -100, undefined);
    expect(h.incrementCurrentStorage).toHaveBeenCalledWith('org2', -7, undefined);
    // Both personal files collapse into one deduction on the uploader.
    expect(h.userForRefund).toHaveBeenCalledTimes(1);
    expect(h.userForRefund).toHaveBeenCalledWith(OWNER);
    expect(h.changeStorageSize).toHaveBeenCalledTimes(1);
    expect(h.changeStorageSize).toHaveBeenCalledWith(expect.objectContaining({ id: OWNER }), -105);
  });

  it("refunds the org, not the deleting user, when an admin deletes someone else's org file", async () => {
    const file = chargedFile('507f1f77bcf86cd799439041', { fileSize: 30, userId: 'uploader', organizationId: 'org1' });
    h.findById.mockResolvedValue(file);
    h.findByIdAndUserId.mockResolvedValue(file);
    const { res } = makeRes();

    await run([file.id], res);

    expect(h.incrementCurrentStorage).toHaveBeenCalledWith('org1', -30, undefined);
    expect(h.userForRefund).not.toHaveBeenCalled();
    expect(h.changeStorageSize).not.toHaveBeenCalled();
  });
});

describe('bulk-delete - scope gate', () => {
  it('requires files:write at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['files:write'] });
  });
});
