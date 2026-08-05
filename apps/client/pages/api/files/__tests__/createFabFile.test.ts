import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  fabFileCreate: vi.fn(),
  userFindById: vi.fn(),
  findByDatalakeTag: vi.fn(),
  batchFindById: vi.fn(),
  getSettingsValue: vi.fn(),
  recomputeStatsForLakeTags: vi.fn(),
}));

// Single-method chain: the route only calls `.use(...).post(...)`, and the ability check in
// `.use` is not the subject here, so the middleware itself is dropped rather than run.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (h: unknown) => h }) }),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/dataLakes/recomputeStatsForLakeTags', () => ({
  recomputeStatsForLakeTags: h.recomputeStatsForLakeTags,
}));
vi.mock('@server/utils/browserUploadUrl', () => ({ resolveBrowserUploadUrl: (_id: string, url: string) => url }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(async () => 'https://s3.test/put') }),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag },
  dataLakeBatchRepository: { findById: h.batchFindById },
  FabFile: { create: h.fabFileCreate },
  User: { findById: h.userFindById },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

// Only the settings read is stubbed; checkStorageLimitForFile, resolveSupportedMimeType, etc.
// are real gates on this path.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSettingsMap: vi.fn(async () => ({})) };
});

import handler from '../createFabFile';

const LAKE = {
  id: 'lake-1',
  // Slug and prefix deliberately differ: deriving the fallback from the slug instead of the
  // lake's fileTagPrefix would otherwise pass unnoticed.
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
    user: { id: 'u1', isAdmin: false },
    ability: {},
    body,
    logger: { error: vi.fn(), warn: vi.fn() },
  }) as never;

const run = (body: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req(body), res);

const body = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'report.txt',
  mimeType: 'text/plain',
  fileSize: 10,
  type: KnowledgeType.FILE,
  ...overrides,
});

const tagNamesOf = (callIndex = 0) => {
  const persisted = h.fabFileCreate.mock.calls[callIndex][0] as { tags?: { name: string }[] };
  return persisted.tags?.map(t => t.name).sort();
};

describe('POST /api/files/createFabFile - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
  });

  it('stamps the lake prefix when a lake meta-tag arrives with no tag under that prefix', async () => {
    const { res } = makeRes();
    await run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(tagNamesOf()).toEqual(['acme:uncategorized', 'datalake:orga:acme-2026']);
  });

  it('adds no extra stamp when a tag under the lake prefix is already present', async () => {
    const { res } = makeRes();
    await run(
      body({
        tags: [
          { name: 'datalake:orga:acme-2026', strength: 1 },
          { name: 'acme:legal', strength: 1 },
        ],
      }),
      res
    );

    expect(tagNamesOf()).toEqual(['acme:legal', 'datalake:orga:acme-2026']);
  });

  it('leaves a request with no lake meta-tag untouched and never looks a lake up', async () => {
    const { res } = makeRes();
    await run(body(), res);

    expect(h.fabFileCreate.mock.calls[0][0]).not.toHaveProperty('tags');
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('recomputes the lake when content lands straight into it (#1342)', async () => {
    // This door reaches no batch and no membership service. Without the recompute the lake's
    // counts stay stale and it never leaves 'draft', so it never appears in Discover.
    const { res } = makeRes();
    await run(body({ content: 'hello', tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.recomputeStatsForLakeTags).toHaveBeenCalledWith(
      expect.arrayContaining(['datalake:orga:acme-2026']),
      expect.anything()
    );
  });

  it('does not recompute a presign-style create, whose bytes are not in storage yet', async () => {
    // No content means the service mints a presignedUrl and the upload has not happened.
    // Activation is one-way, so counting that row could park an empty lake in Discover forever.
    const { res } = makeRes();
    await run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.recomputeStatsForLakeTags).not.toHaveBeenCalled();
  });
});

describe('POST /api/files/createFabFile - batch ownership (IDOR guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
    h.getSettingsValue.mockResolvedValue(true);
  });

  it('never looks up a batch or checks the feature flag when none was sent', async () => {
    const { res } = makeRes();
    await run(body(), res);

    expect(h.getSettingsValue).not.toHaveBeenCalled();
    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses a batchId when Data Lakes is disabled, before ever looking the batch up', async () => {
    h.getSettingsValue.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/feature/i);
    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('stamps batchId onto the created file when the caller owns the batch', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1' });
    const { res } = makeRes();
    await run(body({ batchId: 'b1' }), res);

    expect(h.batchFindById).toHaveBeenCalledWith('b1');
    expect(h.fabFileCreate.mock.calls[0][0]).toMatchObject({ batchId: 'b1' });
  });

  it('rejects a batchId belonging to another user, without creating a file', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'someone-else' });
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/batch not found/i);
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('rejects a batchId that does not exist, without creating a file', async () => {
    h.batchFindById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/batch not found/i);
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });
});
