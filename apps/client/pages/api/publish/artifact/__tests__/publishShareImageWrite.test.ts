import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createMocks } from 'node-mocks-http';

/**
 * The publish-time shareImageUrl write, driven through both real handlers (upload-url -> draft ->
 * finalize). Scaffolding mirrors publishTagsWrite.test.ts; the rule under test is the same
 * add-only one: a publish can set the image, only PATCH clears it.
 */

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

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
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

// `@bike4mind/common` is deliberately NOT mocked: parseShareImageUrl is the validator under test. Only the heavy publish-service surface is stubbed,
// far enough for each handler to reach its write.
// finalize reaches the quota check through planVersionedPublish, which imports it from this module.
vi.mock('@server/services/publish/checkPublishQuota', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, checkPublishQuota: () => Promise.resolve({ ok: true }) };
});
vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    validateBundle: () => ({ valid: true, violations: [] }),
    checkScopePermission: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility?: string) => ({ ok: true, visibility: visibility ?? 'private' }),
    buildPublishS3KeyPrefix: () => 'user/owner1/s/',
    buildPublishUrlPath: () => '/p/u/owner1/s',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
    mintDraftUploadUrl: () => Promise.resolve({ url: 'https://example.invalid/put' }),
    consumePublishAction: () => Promise.resolve({ refund: () => Promise.resolve() }),
  };
});

import finalizeHandler from '../finalize';
import uploadUrlHandler from '../upload-url';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const INDEX_HTML = '<html><head></head><body><h1>Hi</h1></body></html>';

const post = (handler: unknown, body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const r = req as Record<string, unknown>;
  r.user = { id: 'owner1', isAdmin: false, organizationId: null };
  r.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { res, promise: (handler as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

// -- finalize: draft manifest -> the artifact's $set --

const manifest = (over: Record<string, unknown> = {}) => ({
  draftId: DRAFT_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 's',
  title: 'My Artifact',
  visibility: 'private',
  source: { kind: 'bundle' },
  files: [{ path: 'index.html', size: INDEX_HTML.length, mimeType: 'text/html' }],
  ...over,
});

/** Run finalize against a draft manifest and return the `$set` it wrote. */
async function finalizeWith(over: Record<string, unknown>): Promise<Record<string, unknown>> {
  mockDownload.mockImplementation((key: string) =>
    key.endsWith('_manifest.json')
      ? Promise.resolve(Buffer.from(JSON.stringify(manifest(over))))
      : Promise.resolve(Buffer.from(INDEX_HTML))
  );
  const { res, promise } = post(finalizeHandler, { draftId: DRAFT_ID });
  await promise;
  expect(res._getStatusCode()).toBe(200);
  return (mockFindOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;
}

// -- upload-url: request body -> the draft manifest written to storage --

const uploadBody = (over: Record<string, unknown> = {}) => ({
  tier: 'user',
  scopeId: 'owner1',
  // SlugSchema's floor is 3 chars; finalize reads the slug off an already-issued draft, whose own
  // schema is a plain string, which is why its fixture can be shorter.
  slug: 'doc',
  title: 'My Artifact',
  files: [{ path: 'index.html', size: INDEX_HTML.length, mimeType: 'text/html' }],
  ...over,
});

/** Run upload-url and return the draft manifest it uploaded. */
async function draftFrom(over: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { res, promise } = post(uploadUrlHandler, uploadBody(over));
  await promise;
  expect(res._getStatusCode()).toBe(200);
  const call = mockUpload.mock.calls.find(c => String(c[1]).endsWith('_manifest.json'));
  return JSON.parse(String(call![0]));
}

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null); // first publish (no previous)
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'private', publicId: 'pub1' });
  mockDownload.mockReset();
  mockUpload.mockReset().mockResolvedValue(undefined);
});

const IMAGE = 'https://images.example.org/cards/a.png';

describe('upload-url - shareImageUrl carried on the draft', () => {
  it('carries the normalized image', async () => {
    expect((await draftFrom({ shareImageUrl: 'https://Images.Example.org/cards/a.png#x' })).shareImageUrl).toBe(IMAGE);
  });

  it('carries no image when the caller omits it', async () => {
    expect((await draftFrom({})).shareImageUrl).toBeUndefined();
  });

  it.each([
    ['an artifact thumbnail', 'https://cdn.example.com/publish-thumbnails/pub1/abc.webp'],
    ['a presigned link', 'https://bucket.example.com/a.png?X-Amz-Signature=abc'],
    ['a bundle-relative path', 'assets/card.png'],
  ])('rejects %s before issuing a draft', async (_label, shareImageUrl) => {
    const { res, promise } = post(uploadUrlHandler, uploadBody({ shareImageUrl }));
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('finalize - shareImageUrl write', () => {
  it('writes the image the draft carries', async () => {
    expect((await finalizeWith({ shareImageUrl: IMAGE })).shareImageUrl).toBe(IMAGE);
  });

  it('writes nothing when the draft has none, so a re-publish keeps the stored image', async () => {
    expect('shareImageUrl' in (await finalizeWith({}))).toBe(false);
  });

  it('re-validates the draft and drops an image that fails', async () => {
    const set = await finalizeWith({ shareImageUrl: 'https://cdn.example.com/publish-thumbnails/pub1/a.webp' });
    expect('shareImageUrl' in set).toBe(false);
  });
});
