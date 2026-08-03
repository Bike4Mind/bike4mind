import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  fabFileCreate: vi.fn(),
  userFindById: vi.fn(),
  findByDatalakeTag: vi.fn(),
}));

// Single-method chain: the route only calls `.use(...).post(...)`, and the ability check in
// `.use` is not the subject here, so the middleware itself is dropped rather than run.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ use: () => ({ post: (h: unknown) => h }) }),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/browserUploadUrl', () => ({ resolveBrowserUploadUrl: (_id: string, url: string) => url }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(async () => 'https://s3.test/put') }),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag },
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
});
