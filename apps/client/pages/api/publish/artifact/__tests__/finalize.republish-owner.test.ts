import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Republishing an existing slug is limited to the artifact owner (or an admin); other callers get 403
// before any storage or database write - at upload-url, and again at finalize.

const { mockFindOne, mockFindOneAndUpdate, mockDownload, mockUpload, mockInvalidate, mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInvalidate: vi.fn(),
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

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({
    download: mockDownload,
    upload: mockUpload,
    delete: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({
      select: (proj: string) => {
        mockSelect(proj);
        return { lean: () => Promise.resolve(mockFindOne()) };
      },
    }),
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
    invalidatePublishCdn: mockInvalidate,
    toCacheTarget: (a: { publicId: string }) => ({ publicId: a.publicId }),
    mintDraftUploadUrl: () => Promise.resolve('https://example.invalid/put'),
    consumePublishAction: () => Promise.resolve({ refund: () => Promise.resolve() }),
  };
});

import handler from '../finalize';
import uploadUrlHandler from '../upload-url';

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

const post = (h: unknown, body: unknown, userId: string, isAdmin: boolean) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const r = req as Record<string, unknown>;
  r.user = { id: userId, isAdmin, organizationId: null };
  r.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { res, promise: (h as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};
const run = (body: unknown, userId = 'owner1', isAdmin = false) => post(handler, body, userId, isAdmin);

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null);
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'public', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
  mockInvalidate.mockReset().mockResolvedValue(undefined);
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
    expect(res._getJSONData().code).toBe('slug_owned_by_other');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses an org member republishing a colleague's org page", async () => {
    mockFindOne.mockResolvedValue(existing);
    setDraft(manifest({ tier: 'organization', scopeId: 'org1', createdBy: 'member2' }), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID }, 'member2');
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().code).toBe('slug_owned_by_other');
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('lets the owner republish an existing slug (200)', async () => {
    mockFindOne.mockResolvedValue(existing);
    setDraft(manifest({}), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
  });

  it('lets an admin republish a slug they do not own, keeping the original owner', async () => {
    mockFindOne.mockResolvedValue(existing);
    setDraft(manifest({ createdBy: 'admin9' }), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID }, 'admin9', true);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter.ownerId).toBe('owner1');
    expect(update.$set.ownerId).toBe('owner1');
  });

  it('guards the upsert on the owner it checked, so a first publish cannot land on a row created meanwhile', async () => {
    setDraft(manifest({}), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect((mockFindOneAndUpdate.mock.calls[0][0] as Record<string, unknown>).ownerId).toBe('owner1');
  });

  it('returns 409 when the slug changed owner between the check and the write', async () => {
    mockFindOneAndUpdate.mockReturnValue(
      Promise.reject(Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 }))
    );
    setDraft(manifest({}), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData().code).toBe('slug_owned_by_other');
  });

  it('does not report an owner change for a database failure', async () => {
    mockFindOneAndUpdate.mockReturnValue(Promise.reject(new Error('boom')));
    setDraft(manifest({}), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });

    await expect(promise).rejects.toThrow('boom');
    expect(res._getStatusCode()).not.toBe(409);
  });
});

describe('finalize - CDN purge on re-publish', () => {
  it('purges the page when a public page is re-published private, so the cached public copy stops serving', async () => {
    mockFindOne.mockResolvedValue({ ...existing, visibility: 'public' });
    mockFindOneAndUpdate.mockResolvedValue({ visibility: 'private', publicId: 'pub1' });
    setDraft(manifest({ visibility: 'private' }), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockInvalidate).toHaveBeenCalledWith({ publicId: 'pub1' }, expect.anything());
    expect(mockSelect).toHaveBeenCalledWith(expect.stringContaining('visibility'));
  });

  it('does not purge when the page was and stays private', async () => {
    mockFindOne.mockResolvedValue({ ...existing, visibility: 'private' });
    mockFindOneAndUpdate.mockResolvedValue({ visibility: 'private', publicId: 'pub1' });
    setDraft(manifest({ visibility: 'private' }), '<h1>x</h1>');
    const { res, promise } = run({ draftId: DRAFT_ID });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});

describe('upload-url - republish ownership', () => {
  const uploadBody = {
    tier: 'user',
    scopeId: 'owner1',
    slug: 'art',
    title: 'My Artifact',
    files: [{ path: 'index.html', size: 10, mimeType: 'text/html' }],
  };

  it('refuses a non-owner before issuing upload URLs or writing a draft', async () => {
    mockFindOne.mockResolvedValue(existing);
    const { res, promise } = post(uploadUrlHandler, uploadBody, 'member2', false);
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().code).toBe('slug_owned_by_other');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses an org member a draft for a colleague's org page", async () => {
    mockFindOne.mockResolvedValue(existing);
    const { res, promise } = post(
      uploadUrlHandler,
      { ...uploadBody, tier: 'organization', scopeId: 'org1' },
      'member2',
      false
    );
    await promise;

    expect(res._getStatusCode()).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('issues a draft to the owner and to an admin', async () => {
    mockFindOne.mockResolvedValue(existing);
    for (const [userId, isAdmin] of [
      ['owner1', false],
      ['admin9', true],
    ] as const) {
      const { res, promise } = post(uploadUrlHandler, uploadBody, userId, isAdmin);
      await promise;
      expect(res._getStatusCode()).toBe(200);
    }
  });
});
