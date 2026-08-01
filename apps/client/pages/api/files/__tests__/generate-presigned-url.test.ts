import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  createFabFile: vi.fn(),
  findByDatalakeTag: vi.fn(),
}));

// The route calls `baseApi().post(...)` directly, with no `.use(...)` in the chain.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (h: unknown) => h }),
}));

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
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag },
}));

// Only the settings read is stubbed; checkStorageLimit and resolveSupportedMimeType are real
// gates on this path. The reconciler (via @bike4mind/services) is left real entirely.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSettingsMap: vi.fn(async () => ({})) };
});

import handler from '../generate-presigned-url';

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
  ...overrides,
});

const tagNamesOf = (callIndex = 0) => {
  const persisted = h.createFabFile.mock.calls[callIndex][0] as { tags?: { name: string }[] };
  return persisted.tags?.map(t => t.name).sort();
};

describe('POST /api/files/generate-presigned-url - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.createFabFile.mockImplementation(async () => ({ id: 'f1' }));
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

    expect(h.createFabFile.mock.calls[0][0]).not.toHaveProperty('tags');
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
  });
});
