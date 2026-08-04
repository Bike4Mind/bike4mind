import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  createFabFile: vi.fn(),
  assertLakeWriteAccess: vi.fn(),
  findByDatalakeTag: vi.fn(),
  lakeFindById: vi.fn(),
  getSettingsValue: vi.fn(),
  batchFindById: vi.fn(),
  appendFiles: vi.fn(),
}));

// Callable chain routed by req.method, same shape as the batches lifecycle test.
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

// The global setup mocks `sst` without a fabFileBucket, and the route reads its name.
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));

// The assertion point: whatever tags reach here are what gets persisted on the FabFile.
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@server/utils/browserUploadUrl', () => ({ resolveBrowserUploadUrl: (_id: string, url: string) => url }));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, userTags: [], entitlementKeys: [] })),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  dataLakeBatchRepository: { findById: h.batchFindById, appendFiles: h.appendFiles },
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, findById: h.lakeFindById },
}));

// Partial: only the lake-authorization collaborators are stubbed. The fallback tagger is the
// subject of these tests and must be the real one - a mocked reconciler would only prove the
// mock returned what the mock was told to return.
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<{ dataLakeService: Record<string, unknown> }>();
  return {
    ...actual,
    dataLakeService: {
      ...actual.dataLakeService,
      assertLakeWriteAccess: h.assertLakeWriteAccess,
      assertCanWriteDataLakeTags: vi.fn(),
    },
  };
});

// resolveSupportedMimeType and checkStorageLimit are real gates on this path; only the settings
// read is stubbed.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSettingsMap: vi.fn(async () => ({})) };
});

import handler from '../generate-presigned-urls-batch';

const LAKE = {
  id: 'lake-1',
  // Slug and prefix deliberately differ: deriving the fallback from `dataLakeSlug` instead of
  // the lake's fileTagPrefix would otherwise pass unnoticed.
  slug: 'acme-2026',
  createdByUserId: 'u1',
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};

const req = (body: unknown) =>
  ({
    method: 'POST',
    user: { id: 'u1', isAdmin: false, tags: [], groups: [] },
    ability: {},
    body,
    logger: { error: vi.fn(), warn: vi.fn() },
  }) as never;

const run = (body: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(body), res);

const file = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'report.txt',
  mimeType: 'text/plain',
  fileSize: 10,
  relativePath: 'report.txt',
  tags: [],
  ...overrides,
});

const tagNamesOf = (callIndex = 0) =>
  ((h.createFabFile.mock.calls[callIndex][0] as { tags?: { name: string }[] }).tags ?? []).map(t => t.name).sort();

describe('POST /api/files/generate-presigned-urls-batch - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue(true);
    h.assertLakeWriteAccess.mockResolvedValue(LAKE);
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.createFabFile.mockImplementation(async () => ({ id: `f${h.createFabFile.mock.calls.length}` }));
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: LAKE.id });
    h.appendFiles.mockResolvedValue(null);
  });

  it('gives a flat upload a tag under the lake prefix, not just the meta-tag', async () => {
    // The reported bug: a file picked through "Upload Files..." has a relativePath with no
    // separator, so the wizard derives no content tag and the file was invisible to tag-counts.
    const { res } = makeRes();
    await run({ files: [file()], dataLakeSlug: 'acme-2026' }, res);

    expect(tagNamesOf()).toEqual(['acme:uncategorized', 'datalake:orga:acme-2026']);
  });

  it('leaves a file that already carries a lake content tag alone', async () => {
    const { res } = makeRes();
    await run(
      {
        files: [file({ relativePath: 'legal/a.txt', tags: [{ name: 'acme:legal', strength: 1 }] })],
        dataLakeSlug: 'acme-2026',
      },
      res
    );

    expect(tagNamesOf()).toEqual(['acme:legal', 'datalake:orga:acme-2026']);
  });

  it('stamps when the only client tag falls outside the lake prefix', async () => {
    // Guards against implementing the check as "has any tag": both cases above still pass under
    // that mistake, this one does not.
    const { res } = makeRes();
    await run({ files: [file({ tags: [{ name: 'important', strength: 1 }] })], dataLakeSlug: 'acme-2026' }, res);

    expect(tagNamesOf()).toEqual(['acme:uncategorized', 'datalake:orga:acme-2026', 'important']);
  });

  it('adds nothing to an upload that is not bound to a lake', async () => {
    const { res } = makeRes();
    await run({ files: [file()] }, res);

    expect(tagNamesOf()).toEqual([]);
    expect(h.assertLakeWriteAccess).not.toHaveBeenCalled();
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('decides per file, and looks the lake up once for the whole batch', async () => {
    const { res } = makeRes();
    await run(
      {
        files: [
          file({ fileName: 'flat.txt', relativePath: 'flat.txt' }),
          file({ fileName: 'a.txt', relativePath: 'legal/a.txt', tags: [{ name: 'acme:legal', strength: 1 }] }),
        ],
        dataLakeSlug: 'acme-2026',
        batchId: 'b1',
      },
      res
    );

    expect(h.createFabFile).toHaveBeenCalledTimes(2);
    expect(tagNamesOf(0)).toContain('acme:uncategorized');
    expect(tagNamesOf(1)).not.toContain('acme:uncategorized');
    expect(h.findByDatalakeTag).toHaveBeenCalledTimes(1);
    expect(h.appendFiles).toHaveBeenCalled();
  });

  it('does not let a smuggled meta-tag stand in for a content tag', async () => {
    const { res } = makeRes();
    await run(
      {
        files: [file({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] })],
        dataLakeSlug: 'acme-2026',
      },
      res
    );

    // Two things at once: a meta-tag does not count as a content tag (without that exclusion the
    // file would look categorized and get no stamp), and the server's injected copy is deduped
    // against the client's rather than persisted twice.
    const names = tagNamesOf();
    expect(names).toContain('acme:uncategorized');
    expect(names.filter(n => n === 'datalake:orga:acme-2026')).toHaveLength(1);
  });

  it('keeps the server strength on the meta-tag when a client sends its own', async () => {
    const { res } = makeRes();
    await run(
      {
        files: [file({ tags: [{ name: 'datalake:orga:acme-2026', strength: 0.01 }] })],
        dataLakeSlug: 'acme-2026',
      },
      res
    );

    const persisted = (h.createFabFile.mock.calls[0][0] as { tags: { name: string; strength: number }[] }).tags;
    expect(persisted.find(t => t.name === 'datalake:orga:acme-2026')?.strength).toBe(1.0);
  });
});

describe('POST /api/files/generate-presigned-urls-batch - lake targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockResolvedValue(true);
    h.assertLakeWriteAccess.mockResolvedValue(LAKE);
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.lakeFindById.mockResolvedValue(LAKE);
    h.createFabFile.mockImplementation(async () => ({ id: `f${h.createFabFile.mock.calls.length}` }));
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: LAKE.id });
    h.appendFiles.mockResolvedValue(null);
  });

  it('refuses files whose batch belongs to a lake other than the one the reference resolves to', async () => {
    // The wizard used to send a slug derived from the lake's NAME, which on a collision resolves
    // to the lake that already held it - so the batch pointed at the new lake while the files
    // were tagged into someone else's. The batch's binding is the authority.
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: 'lake-2' });
    const { res } = makeRes();

    await expect(run({ files: [file()], dataLakeSlug: 'acme-2026', batchId: 'b1' }, res)).rejects.toThrow(
      /different data lake/
    );
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('refuses a batch that carries no lake binding at all', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1' });
    const { res } = makeRes();

    await expect(run({ files: [file()], dataLakeSlug: 'acme-2026', batchId: 'b1' }, res)).rejects.toThrow(
      /different data lake/
    );
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('presigns when the batch and the lake reference agree', async () => {
    const { res } = makeRes();
    await run({ files: [file()], dataLakeSlug: 'acme-2026', batchId: 'b1' }, res);

    expect(h.createFabFile).toHaveBeenCalledTimes(1);
    expect(h.appendFiles).toHaveBeenCalled();
  });

  it('leaves a batch upload with no lake reference alone', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1', dataLakeId: 'lake-2' });
    const { res } = makeRes();
    await run({ files: [file()], batchId: 'b1' }, res);

    expect(h.createFabFile).toHaveBeenCalledTimes(1);
    expect(h.assertLakeWriteAccess).not.toHaveBeenCalled();
  });

  it('rejects a client meta-tag that names a lake other than the one being joined', async () => {
    const { res } = makeRes();

    await expect(
      run(
        {
          files: [file({ tags: [{ name: 'datalake:orgb:other-lake', strength: 1 }] })],
          dataLakeSlug: 'acme-2026',
        },
        res
      )
    ).rejects.toThrow(/names a different data lake/);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it("holds a client meta-tag against the batch's lake when no lake reference was sent", async () => {
    // The write gate alone lets this through for an admin, who may write into any lake.
    const { res } = makeRes();

    await expect(
      run({ files: [file({ tags: [{ name: 'datalake:orgb:other-lake', strength: 1 }] })], batchId: 'b1' }, res)
    ).rejects.toThrow(/names a different data lake/);
    expect(h.lakeFindById).toHaveBeenCalledWith(LAKE.id);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it("refuses the meta-tag rather than honoring it when the batch's lake cannot be resolved", async () => {
    // Falling through to the write gate here would reopen the hole: that gate grants an admin
    // every lake, so it would honor the tag.
    h.lakeFindById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(
      run({ files: [file({ tags: [{ name: 'datalake:orgb:other-lake', strength: 1 }] })], batchId: 'b1' }, res)
    ).rejects.toThrow(/Could not confirm which data lake/);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });
});
