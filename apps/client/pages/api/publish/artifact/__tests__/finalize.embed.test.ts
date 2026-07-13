import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Regression guard for the embed allowlist on the publish (finalize) path. The
// allowlist is managed post-publish via PATCH and is NOT part of the normal publish
// payload, so a plain re-publish MUST NOT clobber it - finalize only writes
// embedOrigins when the draft explicitly carried it (mirrors accessGate).

const { mockFindOne, mockFindOneAndUpdate, mockDownload, mockUpload } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockDownload: vi.fn(),
  mockUpload: vi.fn(() => Promise.resolve()),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/utils/storage', () => ({
  getPublishedArtifactsStorage: () => ({
    download: mockDownload,
    upload: mockUpload,
    delete: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(mockFindOne()) }) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(mockFindOneAndUpdate(...a)),
  },
}));

// Keep the REAL validateEmbedOrigins (that's the logic under test); stub the rest of
// the heavy publish-service surface so the handler reaches the upsert.
vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    validateBundle: () => ({ valid: true, violations: [] }),
    checkScopePermission: () => Promise.resolve({ ok: true }),
    checkPublishQuota: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility: string) => ({ ok: true, visibility }),
    buildPublishS3KeyPrefix: () => 'user/owner1/s/',
    buildPublishUrlPath: () => '/p/u/owner1/s',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
  };
});

import handler from '../finalize';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const INDEX_HTML = '<html><head></head><body><h1>Hi</h1></body></html>';

const manifest = (over: Record<string, unknown> = {}) => ({
  draftId: DRAFT_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 's',
  title: 'My Artifact',
  visibility: 'public',
  source: { kind: 'bundle' },
  files: [{ path: 'index.html', size: INDEX_HTML.length, mimeType: 'text/html' }],
  ...over,
});

const run = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const r = req as Record<string, unknown>;
  r.user = { id: 'owner1', isAdmin: false, organizationId: null };
  r.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const setManifest = (m: Record<string, unknown>) => {
  mockDownload.mockImplementation((key: string) =>
    key.endsWith('_manifest.json')
      ? Promise.resolve(Buffer.from(JSON.stringify(m)))
      : Promise.resolve(Buffer.from(INDEX_HTML))
  );
};

const savedSetArg = () => (mockFindOneAndUpdate.mock.calls[0]?.[1] as { $set: Record<string, unknown> }).$set;

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null); // first publish (no previous)
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'public', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
});

describe('finalize - embed allowlist preserve-on-republish', () => {
  it('does NOT write embedOrigins when the draft omits it (a plain re-publish preserves the allowlist)', async () => {
    setManifest(manifest());
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    // The key must be ABSENT (not embedOrigins: []), so the upsert leaves any prior value intact.
    expect('embedOrigins' in savedSetArg()).toBe(false);
  });

  it('writes the normalized allowlist when the draft explicitly carries it (public)', async () => {
    setManifest(manifest({ embedOrigins: ['https://Example.com/', 'https://example.com'] }));
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(savedSetArg().embedOrigins).toEqual(['https://example.com']);
  });

  it('rejects an explicit allowlist on a non-public draft (EMBED_REQUIRES_OPEN_PUBLIC)', async () => {
    setManifest(manifest({ visibility: 'private', embedOrigins: ['https://example.com'] }));
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { code?: string }).code).toBe('EMBED_REQUIRES_OPEN_PUBLIC');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects an allowlist when the PRESERVED previous artifact is gated (public draft, but gate survives)', async () => {
    // A re-publish keeps the prior access gate, so "open public" must account for it -
    // a public-visibility draft against a gated artifact is NOT open-public.
    mockFindOne.mockResolvedValue({ publicId: 'pub1', accessGate: { kind: 'passphrase' } });
    setManifest(manifest({ visibility: 'public', embedOrigins: ['https://example.com'] }));
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(400);
    expect((res._getJSONData() as { code?: string }).code).toBe('EMBED_REQUIRES_OPEN_PUBLIC');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
