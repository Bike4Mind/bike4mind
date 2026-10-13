import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Republishing an existing slug is limited to the artifact owner (or an admin); other callers get 403
// before any storage or database write.

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

vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkScopePermission: () => Promise.resolve({ ok: true }),
    checkPublishQuota: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility: string) => ({ ok: true, visibility }),
    buildPublishS3KeyPrefix: () => 'user/owner1/art/',
    buildPublishUrlPath: () => '/p/u/owner1/art',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
  };
});

import handler from '../finalize';

const DRAFT_ID = '33333333-3333-4333-8333-333333333333';

const manifest = (over: Record<string, unknown>) => ({
  source: { kind: 'bundle' },
  draftId: DRAFT_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 'art',
  title: 'My Artifact',
  visibility: 'public',
  files: [{ path: 'index.html', size: 1, mimeType: 'text/html' }],
  ...over,
});

const setDraft = (m: Record<string, unknown>, rawIndexHtml: string) => {
  mockDownload.mockImplementation((key: string) =>
    key.endsWith('_manifest.json')
      ? Promise.resolve(Buffer.from(JSON.stringify(m)))
      : Promise.resolve(Buffer.from(rawIndexHtml))
  );
};

const run = (body: unknown, userId = 'owner1') => {
  const { req, res } = createMocks({ method: 'POST', body });
  const r = req as Record<string, unknown>;
  r.user = { id: userId, isAdmin: false, organizationId: null };
  r.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null);
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'public', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
});

const existing = {
  publicId: 'pub1',
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
  ownerId: 'owner1',
  size: { totalBytes: 1, fileCount: 1 },
};

describe('finalize - republish ownership', () => {
  it('returns 403 and writes nothing when a different member republishes an existing slug', async () => {
    mockFindOne.mockResolvedValue(existing);
    setDraft(manifest({ createdBy: 'member2' }), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID }, 'member2');
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('lets the owner republish an existing slug (200)', async () => {
    mockFindOne.mockResolvedValue(existing);
    setDraft(manifest({}), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
  });
});
