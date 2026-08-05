import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findAccessibleById: vi.fn(),
  update: vi.fn(),
  findByDatalakeTag: vi.fn(),
  // The membership write pair `reconcileLakeTags` now owns: `findById` backs the leave path's
  // own membership check (removeFileFromLake) and update.ts's post-commit re-read; the mutable
  // `store` keeps them consistent with each other and with what pullTagsByFabFileId removes.
  findById: vi.fn(),
  pullTagsByFabFileId: vi.fn(),
  pushTagsByFabFileId: vi.fn(),
  computeDataLakeStats: vi.fn(),
  find: vi.fn(),
  setStats: vi.fn(),
}));

// Callable chain routed by req.method, same shape as the batch/generate-presigned-urls-batch
// tests: the module registers get/put/delete in sequence and the exported default routes by
// method, so a single import can drive just the PUT handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
      put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
      delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
    });
    return chain;
  },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(), getMetadata: vi.fn() }),
}));

// Only `dataLakeRepository.findByDatalakeTag` and the fabFile persistence collaborators are
// stubbed. `fabFileRepository` here is a bare object (not the real repository) since the route
// only reaches `.shareable.findAccessibleById` and `.update` on the PUT path under test.
// Spread the real module first so a transitively-loaded model (Subscription, via the route's
// dataLakes -> entitlements chain) still finds `mongoose`/`executeFacetCompatible`/BaseRepository
// at import time - a full-replace mock omits those and fails the suite to load depending on which
// test in the shard loads the chain first.
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  changeStorageSize: vi.fn(),
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, find: h.find, setStats: h.setStats },
  fabFileChunkRepository: {},
  fabFileRepository: {
    shareable: { findAccessibleById: h.findAccessibleById },
    update: h.update,
    findById: h.findById,
    pullTagsByFabFileId: h.pullTagsByFabFileId,
    pushTagsByFabFileId: h.pushTagsByFabFileId,
    computeDataLakeStats: h.computeDataLakeStats,
  },
  fileTagRepository: {},
  adminSettingsRepository: {},
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  User: {},
}));

import handler from '../index';

const LAKE = {
  id: 'lake-1',
  // Slug and prefix deliberately differ: deriving the fallback from the slug instead of the
  // lake's fileTagPrefix would otherwise pass unnoticed.
  slug: 'acme-2026',
  createdByUserId: 'u1',
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const META = 'datalake:orga:acme-2026';

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};

// The route 404s a non-round-tripping id before anything else runs, so the fixture id has to be
// a real 24-hex ObjectId string rather than a readable slug.
const FILE_ID = '507f1f77bcf86cd799439011';

const req = (body: unknown, id: string = FILE_ID) =>
  ({
    method: 'PUT',
    user: { id: 'u1', isAdmin: false },
    ability: {},
    query: { id },
    body,
    logger: { updateMetadata: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }) as never;

const run = (body: unknown, res: unknown, id?: string) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(body, id), res);

const fabFile = (overrides: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  userId: 'u1',
  fileName: 'notes.txt',
  mimeType: 'text/plain',
  moderationStatus: 'clean',
  tags: [],
  ...overrides,
});

const tagNamesOf = (callIndex = 0) => {
  const persisted = h.update.mock.calls[callIndex][0] as { tags?: { name: string }[] };
  return (persisted.tags ?? []).map(t => t.name).sort();
};

// A stateful double for the whole membership pipeline: the first `db.fabFiles.update()` is a
// real whole-array $set in production, so it has to land in the SAME store the atomic pull/push
// pair and the post-commit re-read operate on - otherwise the re-read sees a document that never
// received that write, which is the mock lying about what Mongo would actually return.
const makeStatefulFabFile = (initial: { id: string; userId: string; tags: { name: string; strength: number }[] }) => {
  const store = { ...initial, tags: [...initial.tags] };
  h.findById.mockImplementation(async () => ({ ...store, tags: [...store.tags] }));
  h.update.mockImplementation(async (doc: { tags?: { name: string; strength: number }[] }) => {
    if (doc.tags !== undefined) store.tags = [...doc.tags];
  });
  h.pullTagsByFabFileId.mockImplementation(async (_id: string, names: string[]) => {
    store.tags = store.tags.filter(t => !names.includes(t.name));
    return 1;
  });
  h.pushTagsByFabFileId.mockImplementation(async (_id: string, names: string[], strength = 0) => {
    const toAdd = names.filter(name => !store.tags.some(t => t.name === name));
    store.tags.push(...toAdd.map(name => ({ name, strength })));
    return toAdd.length;
  });
  return store;
};

describe('PUT /api/files/[id] - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.update.mockResolvedValue(undefined);
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 });
    h.find.mockResolvedValue([]);
  });

  it('stamps the lake prefix when the update keeps the meta-tag with no tag under that prefix', async () => {
    h.findAccessibleById.mockResolvedValue(fabFile({ tags: [{ name: META, strength: 1 }] }));
    makeStatefulFabFile({ id: FILE_ID, userId: 'u1', tags: [{ name: META, strength: 1 }] });
    const { res, json } = makeRes();

    await run({ tags: [{ name: META, strength: 1 }] }, res);

    // First write already carries the backfill: this lake is neither joining nor leaving, so
    // nothing runs in commit() and the array persisted here is the final state.
    expect(tagNamesOf()).toEqual(['acme:uncategorized', META]);
    expect((json.mock.calls[0][0].tags as { name: string }[]).map(t => t.name).sort()).toEqual([
      'acme:uncategorized',
      META,
    ]);
  });

  it('retracts the stamp when the update drops the meta-tag from a file that carried both', async () => {
    h.findAccessibleById.mockResolvedValue(
      fabFile({
        tags: [
          { name: META, strength: 1 },
          { name: 'acme:uncategorized', strength: 1 },
        ],
      })
    );
    makeStatefulFabFile({
      id: FILE_ID,
      userId: 'u1',
      tags: [
        { name: META, strength: 1 },
        { name: 'acme:uncategorized', strength: 1 },
      ],
    });
    const { res, json } = makeRes();

    await run({ tags: [] }, res);

    // The first write keeps the meta-tag (and the fallback tagger re-backfills its content tag,
    // since as far as tagsToPersist is concerned the lake is still current) so removeFileFromLake
    // can still see the file as a member and pull BOTH atomically. The route's final response -
    // what a client actually observes - is what matters here, not that intermediate array.
    expect(h.pullTagsByFabFileId).toHaveBeenCalledWith(FILE_ID, [META, 'acme:uncategorized']);
    expect(json.mock.calls[0][0].tags).toEqual([]);
  });

  it('does not change tags and never looks a lake up when tags is omitted (a rename)', async () => {
    const previousTags = [{ name: 'notes', strength: 1 }];
    h.findAccessibleById.mockResolvedValue(fabFile({ tags: previousTags }));
    const { res } = makeRes();

    await run({ fileName: 'renamed.txt' }, res);

    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    // The route always sends the `tags` key (see update.ts's `!== undefined` guard comment), so
    // an omitted-tags request arrives as an explicit `tags: undefined` - the repository layer's
    // $set skips an undefined field, leaving the persisted document's tags untouched. That is
    // the "does not change tags" contract this case is asserting, not literal reference equality.
    const persisted = h.update.mock.calls[0][0] as { tags?: { name: string }[] };
    expect(persisted.tags).toBeUndefined();
  });

  it('stamps nothing for a body carrying only primaryTag and no tags', async () => {
    const previousTags = [{ name: 'notes', strength: 1 }];
    h.findAccessibleById.mockResolvedValue(fabFile({ tags: previousTags }));
    const { res } = makeRes();

    await run({ primaryTag: META }, res);

    // primaryTag is deliberately not a membership signal: it reaches the write gate (which does
    // look the lake up, asserted below) but never the reconciler, so no stamp is minted and
    // `tags` stays untouched (explicit undefined, same as the omitted-tags rename case above).
    expect(h.findByDatalakeTag).toHaveBeenCalled();
    const persisted = h.update.mock.calls[0][0] as { tags?: { name: string }[] };
    expect(persisted.tags).toBeUndefined();
  });

  it('404s a malformed id before the lake write gate or any persistence runs', async () => {
    const { res } = makeRes();

    // 'file-not-real' is 13 characters, so it fails isValid outright; the round trip in the guard
    // is what additionally catches a 12-character string, which isValid accepts and then coerces.
    await run({ tags: [{ name: META, strength: 1 }] }, res, 'file-not-real');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});
